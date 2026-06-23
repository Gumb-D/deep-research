import { generateObject } from 'ai';
import { z } from 'zod';

import { generateObjectWithPromptJson, getMaasConfig } from './ai/maas-compat';
import { getModel } from './ai/providers';
import { systemPrompt } from './prompt';

export async function generateFeedback({
  query,
  numQuestions = 3,
}: {
  query: string;
  numQuestions?: number;
}) {
  const schema = z.object({
    questions: z
      .array(z.string())
      .describe(
        `Follow up questions to clarify the research direction, max of ${numQuestions}`,
      ),
  });
  const model = getModel();
  const system = systemPrompt();
  const prompt = `Given the following query from the user, ask some follow up questions to clarify the research direction. Return a maximum of ${numQuestions} questions, but feel free to return less if the original query is clear: <query>${query}</query>`;
  const maasConfig = getMaasConfig();

  const userFeedback = maasConfig.enabled
    ? await generateObjectWithPromptJson({
        model,
        taskName: 'follow-up questions',
        system,
        prompt,
        schema,
        config: maasConfig,
      })
    : await generateObject({
        model,
        system,
        prompt,
        schema,
      });

  return userFeedback.object.questions.slice(0, numQuestions);
}
