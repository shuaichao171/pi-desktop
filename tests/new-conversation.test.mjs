import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { useChatStore } from '../packages/ui/src/store.ts';
import { sessionOpenMetrics } from '../packages/ui/src/sessionOpenMetrics.ts';

const project = 'C:/projects/source';
const standalone = 'C:/conversations/new';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise,resolve,reject};
}
function ready(cwd = standalone, sessionId = 'created') {
  return {type:'ready',cwd,sessionId,sessionPath:`${cwd}/${sessionId}.jsonl`,
    model:'model',modelProvider:'provider',thinkingLevel:'off',availableThinkingLevels:['off'],
    contextUsage:null,messages:[],activities:[],fileChanges:[]};
}
function fixture() {
  const activations = [], submissions = [];
  const bridge = {
    newSession: options => {
      const pending = {...deferred(),options:options ? {...options} : undefined};
      activations.push(pending);
      return pending.promise;
    },
    initAgent: async () => { throw new Error('Retry must recreate the requested conversation, not resume the old workspace'); },
    listWorkspaces: async () => [project,standalone],
    listConversationWorkspaces: async () => [standalone],
    getDefaultWorkspace: async () => 'C:/conversations',
    listSessions: async () => [],
    submitInput: async request => {
      submissions.push(request);
      useChatStore.getState().handleEvent({type:'user-message',id:`accepted:${request.id}`,order:0,text:request.text,attachments:request.attachments});
      return {id:request.id,state:'accepted'};
    },
    abort: async () => { throw new Error('A waiting draft must not abort the previous runtime'); },
  };
  useChatStore.setState({bridge,cwd:project,sessionId:'source',sessionPath:`${project}/source.jsonl`,status:'idle',
    workspaces:[project],messages:[{id:'old',order:0,role:'user',text:'Previous conversation',status:'done'}]});
  const publish = (cwd = standalone, sessionId = 'created') => useChatStore.getState().handleEvent(ready(cwd,sessionId));
  return {bridge,activations,submissions,publish};
}

beforeEach(() => {
  sessionOpenMetrics.cancel();
  useChatStore.setState(useChatStore.getInitialState(), true);
});

test('ordinary new conversation immediately exposes an empty editable draft with an independent scope', async () => {
  const host = fixture();
  const opening = useChatStore.getState().newSession();
  const draft = useChatStore.getState();
  assert.equal(draft.status,'idle');
  assert.equal(draft.sessionLoading,false);
  assert.deepEqual(draft.messages,[]);
  assert.ok(draft.sessionPreparation,'Composer uses preparation to remain editable while navigation is pending');
  const scope = {...draft.sessionPreparation.draftScope};
  assert.notDeepEqual(scope,{cwd:project,sessionPath:`${project}/source.jsonl`},'new draft must not inherit source input');
  assert.notDeepEqual(scope,{cwd:project,sessionPath:null},'new draft must not alias the workspace unsaved draft');
  await tick();
  useChatStore.getState().handleEvent({type:'reset',cwd:standalone});
  useChatStore.getState().handleEvent({type:'status',status:'starting'});
  assert.equal(useChatStore.getState().status,'idle');
  assert.deepEqual(useChatStore.getState().sessionPreparation.draftScope,scope);
  host.publish();
  host.activations[0].resolve();
  await opening;
  assert.deepEqual(useChatStore.getState().draftTransfer.from,scope);
  assert.deepEqual(useChatStore.getState().draftTransfer.to,{cwd:standalone,sessionPath:`${standalone}/created.jsonl`});
  assert.equal(useChatStore.getState().sessionPreparation,null);
  const next = useChatStore.getState().newSession();
  assert.notDeepEqual(useChatStore.getState().sessionPreparation.draftScope,scope,'separate new conversations have separate input scopes');
  await tick();
  host.publish(standalone,'second');
  host.activations[1].resolve();
  await next;
});

test('same-target repeated clicks reuse preparation and preserve project options', async () => {
  for (const options of [undefined,{cwd:project}]) {
    const host = fixture();
    const first = useChatStore.getState().newSession(options);
    const before = useChatStore.getState();
    const scope = {...before.sessionPreparation.draftScope};
    const second = useChatStore.getState().newSession(options ? {...options} : undefined);
    await tick();
    assert.equal(host.activations.length,1,'repeat clicks must not create another backend conversation');
    assert.deepEqual(host.activations[0].options,options);
    assert.equal(useChatStore.getState().navigationRequestId,before.navigationRequestId);
    assert.deepEqual(useChatStore.getState().sessionPreparation.draftScope,scope);
    host.publish(options?.cwd ?? standalone);
    host.activations[0].resolve();
    await Promise.all([first,second]);
    assert.equal(useChatStore.getState().cwd,options?.cwd ?? standalone);
  }
});

test('the first input waits for activation ACK, sends once with the actual identity, and does not wait for sidebar scans', async t => {
  const host = fixture(), refresh = deferred();
  host.bridge.listSessions = () => refresh.promise;
  host.bridge.listWorkspaces = () => refresh.promise;
  t.after(() => refresh.resolve([]));
  const opening = useChatStore.getState().newSession();
  const attachments = [{kind:'text',name:'note.txt',mimeType:'text/plain',text:'Keep attachment'}];
  const sending = useChatStore.getState().send('First prepared input',undefined,attachments,'first-input');
  const duplicateClick = useChatStore.getState().newSession();
  await tick();
  assert.equal(host.activations.length,1);
  assert.equal(useChatStore.getState().messages[0].text,'First prepared input');
  host.publish();
  await tick();
  assert.equal(host.submissions.length,0,'a ready event before the main process activation ACK is insufficient');
  let opened = false, sent = false;
  opening.then(() => { opened = true; });
  sending.then(() => { sent = true; });
  host.activations[0].resolve();
  await tick();
  assert.equal(opened,true,'opening must complete while list RPCs are still unresolved');
  assert.equal(sent,true,'waiting input must not depend on list refresh completion');
  await Promise.all([opening,sending,duplicateClick]);
  assert.equal(host.submissions.length,1);
  assert.deepEqual(host.submissions[0],{id:'first-input',sessionId:'created',text:'First prepared input',behavior:undefined,attachments});
  assert.equal(useChatStore.getState().messages.length,1);
  assert.equal(useChatStore.getState().messages[0].id,'accepted:first-input');
  assert.equal(useChatStore.getState().sessions[0].firstMessage,'First prepared input');
  assert.equal(useChatStore.getState().navigationPending,false);
});

test('failed creation rejects the waiting send and retry preserves its draft scope and original project request', async () => {
  const host = fixture();
  const opening = useChatStore.getState().newSession({cwd:project});
  const scope = {...useChatStore.getState().sessionPreparation.draftScope};
  const openingFailed = assert.rejects(opening,/Initialization unavailable/);
  const sendingFailed = assert.rejects(useChatStore.getState().send('Keep this draft',undefined,[],'retry-input'),/Initialization unavailable/);
  await tick();
  useChatStore.getState().handleEvent({type:'reset',cwd:project});
  host.activations[0].reject(new Error('Initialization unavailable'));
  await Promise.all([openingFailed,sendingFailed]);
  assert.equal(host.submissions.length,0);
  assert.equal(useChatStore.getState().status,'error');
  assert.equal(useChatStore.getState().navigationPending,false);
  assert.deepEqual(useChatStore.getState().sessionPreparation.draftScope,scope,'failed view must retain the temporary draft instead of source input');
  assert.deepEqual(useChatStore.getState().messages,[]);
  await assert.rejects(useChatStore.getState().send('Must retry first',undefined,[],'not-ready'),/Initialization unavailable/);
  const retrying = useChatStore.getState().retryAgent();
  await tick();
  assert.equal(host.activations.length,2);
  assert.deepEqual(host.activations[1].options,{cwd:project});
  assert.deepEqual(useChatStore.getState().sessionPreparation.draftScope,scope);
  assert.equal(useChatStore.getState().status,'idle');
  const resent = useChatStore.getState().send('Keep this draft',undefined,[],'retry-input');
  host.publish(project,'retried');
  host.activations[1].resolve();
  await Promise.all([retrying,resent]);
  assert.equal(host.submissions.length,1);
  assert.equal(host.submissions[0].sessionId,'retried');
  assert.equal(host.submissions[0].id,'retry-input');
  assert.deepEqual(useChatStore.getState().draftTransfer.from,scope);
});

test('navigating away cancels a waiting input and late creation completion does not replace the new view', async () => {
  const host = fixture();
  const opening = useChatStore.getState().newSession();
  const cancelled = assert.rejects(useChatStore.getState().send('Never send elsewhere',undefined,[],'cancelled-input'),{name:'AbortError'});
  await tick();
  host.bridge.switchWorkspace = async cwd => {
    await host.activations[0].promise;
    host.publish(cwd,'elsewhere');
  };
  const navigating = useChatStore.getState().switchWorkspace('C:/elsewhere');
  await cancelled;
  host.activations[0].resolve();
  await Promise.all([opening,navigating]);
  assert.equal(host.submissions.length,0);
  assert.equal(useChatStore.getState().sessionId,'elsewhere');
  assert.equal(useChatStore.getState().cwd,'C:/elsewhere');
  assert.deepEqual(useChatStore.getState().messages,[]);
  assert.equal(useChatStore.getState().sessionPreparation,null);
});

test('a newer project creation supersedes the previous draft rather than coalescing across targets', async () => {
  const host = fixture();
  const first = useChatStore.getState().newSession({cwd:project});
  const firstScope = {...useChatStore.getState().sessionPreparation.draftScope};
  const cancelled = assert.rejects(useChatStore.getState().send('Old pending input',undefined,[],'superseded-input'),{name:'AbortError'});
  await tick();
  const second = useChatStore.getState().newSession({cwd:'C:/projects/other'});
  await tick();
  assert.equal(host.activations.length,2);
  assert.notDeepEqual(useChatStore.getState().sessionPreparation.draftScope,firstScope);
  await cancelled;
  host.publish(project,'obsolete');
  host.activations[0].resolve();
  await first;
  assert.notEqual(useChatStore.getState().sessionId,'obsolete');
  host.publish('C:/projects/other','chosen');
  host.activations[1].resolve();
  await second;
  assert.equal(useChatStore.getState().sessionId,'chosen');
  assert.equal(useChatStore.getState().cwd,'C:/projects/other');
  assert.equal(host.submissions.length,0);
});

test('ready followed by an activation ACK failure does not transfer the draft or send its input', async () => {
  const host = fixture();
  const opening = useChatStore.getState().newSession();
  const scope = {...useChatStore.getState().sessionPreparation.draftScope};
  const failed = assert.rejects(opening,/Workspace persistence failed/);
  const sendFailed = assert.rejects(useChatStore.getState().send('Keep after partial activation',undefined,[],'partial-input'),/Workspace persistence failed/);
  await tick();
  host.publish();
  host.activations[0].reject(new Error('Workspace persistence failed'));
  await Promise.all([failed,sendFailed]);
  assert.equal(host.submissions.length,0);
  assert.equal(useChatStore.getState().draftTransfer,null);
  assert.equal(useChatStore.getState().status,'error');
  assert.deepEqual(useChatStore.getState().sessionPreparation.draftScope,scope);
  const retrying = useChatStore.getState().retryAgent();
  assert.deepEqual(useChatStore.getState().sessionPreparation.draftScope,scope);
  await tick();
  assert.equal(host.activations[1].options,undefined);
  host.publish(standalone,'recovered');
  host.activations[1].resolve();
  await retrying;
  assert.deepEqual(useChatStore.getState().draftTransfer.from,scope);
  assert.equal(useChatStore.getState().sessionId,'recovered');
});

test('stopping a waiting first input cancels only the local draft and never aborts the old runtime', async () => {
  const host = fixture();
  const opening = useChatStore.getState().newSession();
  const cancelled = assert.rejects(useChatStore.getState().send('Cancel before ready',undefined,[],'aborted-input'),{name:'AbortError'});
  await useChatStore.getState().abort();
  await cancelled;
  assert.deepEqual(useChatStore.getState().messages,[]);
  assert.equal(useChatStore.getState().status,'idle');
  await tick();
  host.publish();
  host.activations[0].resolve();
  await opening;
  assert.equal(host.submissions.length,0);
  await useChatStore.getState().send('Later input',undefined,[],'later-input');
  assert.equal(host.submissions.length,1);
  assert.equal(host.submissions[0].sessionId,'created');
  assert.equal(host.submissions[0].id,'later-input');
});

test('an immediate subscriber submission sees the complete preparation promise before the draft is published', async t => {
  const host = fixture();
  let sending, observed = false;
  const unsubscribe = useChatStore.subscribe(state => {
    if (!state.sessionPreparation || observed) return;
    observed = true;
    sending = state.send('Immediate first input',undefined,[],'subscriber-input');
  });
  t.after(unsubscribe);
  const opening = useChatStore.getState().newSession();
  assert.equal(observed,true);
  await tick();
  assert.equal(host.submissions.length,0);
  assert.equal(useChatStore.getState().messages[0].text,'Immediate first input');
  host.publish();
  host.activations[0].resolve();
  await Promise.all([opening,sending]);
  assert.equal(host.submissions.length,1);
  assert.equal(host.submissions[0].id,'subscriber-input');
});

test('a creation superseded before dispatch never calls the backend for the abandoned target', async () => {
  const host = fixture();
  const first = useChatStore.getState().newSession({cwd:project});
  const second = useChatStore.getState().newSession({cwd:'C:/projects/last-choice'});
  await tick();
  assert.equal(host.activations.length,1);
  assert.deepEqual(host.activations[0].options,{cwd:'C:/projects/last-choice'});
  host.publish('C:/projects/last-choice','last-choice');
  host.activations[0].resolve();
  await Promise.all([first,second]);
  assert.equal(useChatStore.getState().sessionId,'last-choice');
});

test('a successful abandoned creation hands its draft to the receipt scope without changing the new view or sending', async () => {
  const host = fixture();
  const opening = useChatStore.getState().newSession();
  const preparation = useChatStore.getState().sessionPreparation;
  const cancelled = assert.rejects(useChatStore.getState().send('Recover after leaving',undefined,[],'background-input'),{name:'AbortError'});
  await tick();
  host.bridge.switchWorkspace = async cwd => { host.publish(cwd,'chosen'); useChatStore.getState().handleEvent({type:'status',status:'idle'}); };
  await useChatStore.getState().switchWorkspace('C:/chosen');
  await cancelled;
  const current = useChatStore.getState();
  const receipt = {cwd:standalone,sessionPath:`${standalone}/created.jsonl`};
  host.activations[0].resolve(receipt);
  await opening;
  const after = useChatStore.getState();
  assert.deepEqual(after.backgroundDraftTransfers,[{requestId:preparation.requestId,from:preparation.draftScope,to:receipt}]);
  for (const key of ['cwd','sessionId','sessionPath','status','messages','navigationRequestId','navigationPending','sessionPreparation','draftTransfer']) assert.equal(after[key],current[key],key);
  assert.equal(host.submissions.length,0);
});

test('background receipts accumulate independently from the newest preparation and consumers can acknowledge one at a time', async () => {
  const host = fixture();
  const first = useChatStore.getState().newSession({cwd:project});
  const firstPreparation = useChatStore.getState().sessionPreparation;
  await tick();
  const second = useChatStore.getState().newSession({cwd:'C:/second'});
  const secondPreparation = useChatStore.getState().sessionPreparation;
  await tick();
  const third = useChatStore.getState().newSession({cwd:'C:/third'});
  const thirdPreparation = useChatStore.getState().sessionPreparation;
  await tick();
  const firstReceipt = {cwd:project,sessionPath:`${project}/first.jsonl`};
  const secondReceipt = {cwd:'C:/second',sessionPath:'C:/second/second.jsonl'};
  host.activations[0].resolve(firstReceipt);
  host.activations[1].resolve(secondReceipt);
  await Promise.all([first,second]);
  assert.deepEqual(useChatStore.getState().backgroundDraftTransfers,[
    {requestId:firstPreparation.requestId,from:firstPreparation.draftScope,to:firstReceipt},
    {requestId:secondPreparation.requestId,from:secondPreparation.draftScope,to:secondReceipt},
  ]);
  assert.equal(useChatStore.getState().sessionPreparation,thirdPreparation);
  useChatStore.setState(state => ({backgroundDraftTransfers:state.backgroundDraftTransfers.filter(item => item.requestId !== firstPreparation.requestId)}));
  host.publish('C:/third','third');
  host.activations[2].resolve({cwd:'C:/third',sessionPath:'C:/third/third.jsonl'});
  await third;
  assert.equal(useChatStore.getState().backgroundDraftTransfers.length,1);
  assert.equal(useChatStore.getState().backgroundDraftTransfers[0].requestId,secondPreparation.requestId);
  assert.equal(useChatStore.getState().draftTransfer.requestId,thirdPreparation.requestId,'current creation uses the foreground transfer');
});

test('a receipt remains recoverable when navigation changes during fallback snapshot loading', async () => {
  const host = fixture(), snapshot = deferred();
  host.bridge.getAgentSnapshot = () => snapshot.promise;
  const opening = useChatStore.getState().newSession();
  const preparation = useChatStore.getState().sessionPreparation;
  await tick();
  const receipt = {cwd:standalone,sessionPath:`${standalone}/created.jsonl`};
  host.activations[0].resolve(receipt);
  await tick();
  host.bridge.switchWorkspace = async cwd => host.publish(cwd,'chosen');
  await useChatStore.getState().switchWorkspace('C:/chosen');
  snapshot.resolve({...ready(),sequence:1,status:'idle',queuedCount:0});
  await opening;
  assert.equal(useChatStore.getState().sessionId,'chosen');
  assert.deepEqual(useChatStore.getState().backgroundDraftTransfers,[{requestId:preparation.requestId,from:preparation.draftScope,to:receipt}]);
});

test('bridge replacement clears queued transfers and prevents old receipts from entering the new bridge lifecycle', async () => {
  const host = fixture();
  const opening = useChatStore.getState().newSession();
  await tick();
  useChatStore.setState({backgroundDraftTransfers:[{requestId:0,from:{cwd:'',sessionPath:'draft:old'},to:{cwd:project,sessionPath:'saved'}}]});
  const replacement = {...host.bridge,onAgentEvent:() => () => {},getAppInfo:async () => null,
    getAgentSnapshot:async () => ({...useChatStore.getInitialState(),...ready('C:/replacement','replacement'),sequence:1,status:'idle',sessionRuntimes:[]})};
  useChatStore.getState().setBridge(replacement);
  assert.deepEqual(useChatStore.getState().backgroundDraftTransfers,[]);
  host.activations[0].resolve({cwd:standalone,sessionPath:`${standalone}/created.jsonl`});
  await opening;
  await tick();
  assert.deepEqual(useChatStore.getState().backgroundDraftTransfers,[]);
  assert.equal(useChatStore.getState().sessionId,'replacement');
});

test('an abandoned failed draft is recovered only by a later New action for its original target', async () => {
  const host = fixture();
  const opening = useChatStore.getState().newSession({cwd:project});
  const scope = useChatStore.getState().sessionPreparation.draftScope;
  const failed = assert.rejects(opening,/Background failure/);
  await tick();
  host.bridge.switchWorkspace = async cwd => host.publish(cwd,'chosen');
  await useChatStore.getState().switchWorkspace('C:/chosen');
  host.activations[0].reject(new Error('Background failure'));
  await failed;
  assert.equal(useChatStore.getState().sessionId,'chosen');
  assert.equal(useChatStore.getState().error,null);
  assert.deepEqual(useChatStore.getState().backgroundDraftTransfers,[]);
  const unrelated = useChatStore.getState().newSession({cwd:'C:/other-project'});
  assert.notDeepEqual(useChatStore.getState().sessionPreparation.draftScope,scope);
  await tick();
  host.publish('C:/other-project','other');
  host.activations[1].resolve();
  await unrelated;
  const recovering = useChatStore.getState().newSession({cwd:project});
  assert.deepEqual(useChatStore.getState().sessionPreparation.draftScope,scope);
  await tick();
  assert.deepEqual(host.activations[2].options,{cwd:project});
  host.publish(project,'recovered');
  host.activations[2].resolve();
  await recovering;
  assert.equal(host.submissions.length,0,'recovering a draft never resumes cancelled input');
});

test('leaving a displayed failed draft keeps it recoverable, while retrying it does not leave a duplicate recovery entry', async () => {
  const host = fixture();
  const opening = useChatStore.getState().newSession({cwd:project});
  const scope = useChatStore.getState().sessionPreparation.draftScope;
  const failed = assert.rejects(opening,/Displayed failure/);
  await tick();
  host.activations[0].reject(new Error('Displayed failure'));
  await failed;
  host.bridge.switchWorkspace = async cwd => host.publish(cwd,'chosen');
  await useChatStore.getState().switchWorkspace('C:/chosen');
  const recovering = useChatStore.getState().newSession({cwd:project});
  assert.deepEqual(useChatStore.getState().sessionPreparation.draftScope,scope);
  const failedAgain = assert.rejects(recovering,/Retry failure/);
  await tick();
  host.activations[1].reject(new Error('Retry failure'));
  await failedAgain;
  const retrying = useChatStore.getState().newSession({cwd:project});
  assert.deepEqual(useChatStore.getState().sessionPreparation.draftScope,scope,'New on the same failed target acts as retry');
  await tick();
  host.publish(project,'recovered');
  host.activations[2].resolve();
  await retrying;
  const fresh = useChatStore.getState().newSession({cwd:project});
  assert.notDeepEqual(useChatStore.getState().sessionPreparation.draftScope,scope,'successful retry must consume the recovery entry');
  await tick();
  host.publish(project,'fresh');
  host.activations[3].resolve();
  await fresh;
});

test('model and thinking picked while a new conversation prepares are applied before the first input is sent', async () => {
  const host = fixture(), calls = [];
  let liveModel = {model:'model',modelProvider:'provider',thinkingLevel:'off'};
  host.bridge.setModel = async (provider,id) => { calls.push(['model',provider,id]); liveModel = {...liveModel,model:id,modelProvider:provider}; };
  host.bridge.setThinkingLevel = async level => { calls.push(['thinking',level]); liveModel = {...liveModel,thinkingLevel:level}; };
  host.bridge.getAgentSnapshot = async () => ({...ready(),...liveModel,status:'idle',sequence:1});
  useChatStore.setState({models:[{provider:'other',id:'picked',name:'Picked model',reasoning:true,input:['text'],contextWindow:1,maxTokens:1,thinkingLevels:['off','high']}]});
  const opening = useChatStore.getState().newSession();
  await useChatStore.getState().setModel('other','picked');
  await useChatStore.getState().setThinkingLevel('high');
  assert.deepEqual(calls,[],'nothing reaches the runtime while it is still being prepared');
  assert.equal(useChatStore.getState().model,'picked','the picker shows the choice immediately');
  assert.equal(useChatStore.getState().modelName,'Picked model');
  assert.equal(useChatStore.getState().thinkingLevel,'high');
  const sending = useChatStore.getState().send('After the switch',undefined,[],'deferred-model-input');
  await tick();
  host.publish();
  host.activations[0].resolve();
  await Promise.all([opening,sending]);
  assert.deepEqual(calls,[['model','other','picked'],['thinking','high']]);
  assert.equal(host.submissions.length,1,'the first input waits for the deferred settings');
  assert.equal(useChatStore.getState().model,'picked','the live ready reflects the applied choice');
  assert.equal(useChatStore.getState().modelProvider,'other');
  assert.equal(useChatStore.getState().thinkingLevel,'high');
});

test('a rejected deferred model choice is reported without failing the new conversation', async () => {
  const host = fixture();
  host.bridge.setModel = async () => { throw new Error('Model unavailable'); };
  host.bridge.getAgentSnapshot = async () => ({...ready(),status:'idle',sequence:1});
  const opening = useChatStore.getState().newSession();
  await useChatStore.getState().setModel('other','missing');
  await tick();
  host.publish();
  host.activations[0].resolve();
  await opening;
  assert.equal(useChatStore.getState().sessionId,'created');
  assert.equal(useChatStore.getState().model,'model','the session keeps the model the runtime actually uses');
  assert.equal(useChatStore.getState().settingsError,'Model unavailable');
});
