// Parse every generated CDP expression without a browser, DOM, or model calls.
import scenarios from './scenarios.mjs';
import { installModelSettingsFixture } from './fixture.mjs';
let expressions = 0;
const compile = (expression) => { new Function(expression); expressions += 1; };
await scenarios({
  evaluate: async (expression) => { compile(expression); return 0; },
  waitFor: async (expression) => { compile(expression); },
  assert: async (expression) => { compile(expression); },
  record: async (_name, expression) => { compile(expression); },
  click: async () => {}, clickText: async () => {}, fill: async () => {},
  screenshot: async () => {}, viewport: async () => {}, settle: async () => {},
});
new Function(`(${installModelSettingsFixture.toString()})({});`);
console.log(`Prepared ${expressions} scenario expressions and bridge injection: syntax valid; no browser launched.`);
