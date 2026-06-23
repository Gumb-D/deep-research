import assert from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  extractJsonObject,
  generateObjectWithPromptJson,
  getMaasConfig,
  isMaasPromptJsonEnabled,
} from './maas-compat';

describe('MAAS compatibility helpers', () => {
  it('enables prompt JSON mode only for the exact true string', () => {
    assert.equal(isMaasPromptJsonEnabled('true'), true);
    assert.equal(isMaasPromptJsonEnabled('TRUE'), false);
    assert.equal(isMaasPromptJsonEnabled(' true '), false);
    assert.equal(isMaasPromptJsonEnabled(undefined), false);
  });

  it('clamps MAAS config to safe defaults', () => {
    assert.deepEqual(
      getMaasConfig({
        MAAS_JSON_MAX_TOKENS: '0',
        MAAS_REPORT_MAX_TOKENS: '-1',
        MAAS_JSON_RETRIES: '99',
      }),
      {
        enabled: false,
        jsonMaxTokens: 4096,
        reportMaxTokens: 16000,
        jsonRetries: 5,
      },
    );
  });

  it('extracts JSON from plain text or fenced code blocks', () => {
    assert.deepEqual(extractJsonObject('{"value":"ok"}'), { value: 'ok' });
    assert.deepEqual(extractJsonObject('```json\n{"value":"ok"}\n```'), {
      value: 'ok',
    });
    assert.equal(extractJsonObject('not json at all'), null);
  });

  it('retries until it gets valid stop-finished JSON', async () => {
    const attempts: string[] = [];
    const schema = z.object({
      questions: z.array(z.string()),
    });

    const result = await generateObjectWithPromptJson({
      model: {
        modelId: 'test-model',
      } as any,
      taskName: 'follow-up questions',
      system: 'system',
      prompt: 'prompt',
      schema,
      config: {
        enabled: true,
        jsonMaxTokens: 1234,
        reportMaxTokens: 16000,
        jsonRetries: 2,
      },
      generateTextImpl: async ({ maxTokens }) => {
        attempts.push(String(maxTokens));

        switch (attempts.length) {
          case 1:
            return {
              text: '{"questions":["missing stop"]}',
              finishReason: 'length',
              reasoning: 'hidden',
            } as any;
          case 2:
            return {
              text: '{"questions":[1]}',
              finishReason: 'stop',
              reasoning: 'hidden',
            } as any;
          default:
            return {
              text: '{"questions":["What geography matters most?"]}',
              finishReason: 'stop',
              reasoning: 'hidden',
            } as any;
        }
      },
    });

    assert.deepEqual(result.object.questions, ['What geography matters most?']);
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(attempts, ['1234', '1234', '1234']);
  });

  it('throws a sanitized error after exhausting retries', async () => {
    const schema = z.object({
      questions: z.array(z.string()),
    });

    await assert.rejects(
      () =>
        generateObjectWithPromptJson({
          model: {
            modelId: 'test-model',
          } as any,
          taskName: 'follow-up questions',
          system: 'system',
          prompt: 'prompt',
          schema,
          config: {
            enabled: true,
            jsonMaxTokens: 4096,
            reportMaxTokens: 16000,
            jsonRetries: 1,
          },
          generateTextImpl: async () =>
            ({
              text: '{"questions":[123]}',
              finishReason: 'stop',
              reasoning: 'super secret reasoning content',
            }) as any,
        }),
      error => {
        assert.equal(error instanceof Error, true);
        assert.match(
          (error as Error).message,
          /MAAS prompt JSON failed for "follow-up questions"/,
        );
        assert.match((error as Error).message, /attempts=2/);
        assert.doesNotMatch(
          (error as Error).message,
          /super secret reasoning content|123/,
        );
        return true;
      },
    );
  });
});
