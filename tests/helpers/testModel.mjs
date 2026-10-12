import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Declarative model seed for hermetic agent tests. Clean CI runners have no
// configured provider, so a session starts without a usable model and the
// host's prompt gate (model availability) would reject every send. Writing a
// local custom provider with an api key gives the SDK's default-model resolver
// an available model (it falls back to the first available entry) without any
// network access or reliance on the developer machine's credentials.
// Seed BEFORE importing/creating the service: the runtime reads models.json
// and auth.json from PI_CODING_AGENT_DIR at init.
export const TEST_MODEL_PROVIDER = 'desktop-test-model';
export const TEST_MODEL_ID = 'test-model';

export function seedTestModel(agentDir) {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      [TEST_MODEL_PROVIDER]: {
        name: 'Desktop Test Model',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9/v1',
        models: [{
          id: TEST_MODEL_ID, name: 'Test Model', reasoning: false,
          input: ['text', 'image'], contextWindow: 32768, maxTokens: 4096,
        }],
      },
    },
  }, null, 2));
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({
    [TEST_MODEL_PROVIDER]: { type: 'api_key', key: 'desktop-test-key' },
  }, null, 2));
}
