import { writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { server as mswServer } from "@server/test/msw";
import {
  buildCollection,
  buildDocument,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import { generateAnswerWithUsage } from "../server/generate";
import { retrieveSources } from "../server/retrieve";
import cases from "./cases.json";
import {
  buildFakeSecrets,
  expandSecrets,
  isLocalUrl,
  scoreCase,
  type CaseExpectation,
} from "./score";

/**
 * Live evaluation against the real Anthropic API. Never runs in the normal
 * suite: `run.mjs` enables it, and only with an API key and a local database.
 */
const enabled =
  process.env.AI_ANSWERS_EVAL_LIVE === "1" &&
  Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!enabled)("ai-answers live eval", () => {
  it(
    "runs every case",
    async () => {
      for (const url of [process.env.DATABASE_URL, process.env.REDIS_URL]) {
        if (!url || !isLocalUrl(url)) {
          throw new Error("Refusing to run: database and redis must be local.");
        }
      }
      // The suite blocks outbound requests; this run needs the real API.
      mswServer.close();

      const secrets = buildFakeSecrets();
      const expand = (value: string) => expandSecrets(value, secrets);
      const runs = Number(process.env.AI_ANSWERS_EVAL_RUNS ?? "1");

      const team = await buildTeam();
      const user = await buildUser({ teamId: team.id });
      const owner = await buildUser({ teamId: team.id });
      const collections = {
        open: await buildCollection({ teamId: team.id, userId: user.id }),
        excluded: await buildCollection({
          teamId: team.id,
          userId: user.id,
          aiExcluded: true,
        }),
        // Only its owner can read it.
        private: await buildCollection({
          teamId: team.id,
          userId: owner.id,
          permission: null,
        }),
      };
      for (const doc of cases.corpus) {
        await buildDocument({
          teamId: team.id,
          userId: doc.collection === "private" ? owner.id : user.id,
          collectionId:
            collections[doc.collection as keyof typeof collections].id,
          title: doc.title,
          text: expand(doc.text),
        });
      }

      const client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        timeout: 60_000,
        maxRetries: 1,
      });
      const results = [];
      for (const c of cases.cases) {
        const expectation: CaseExpectation = {
          ...c.expect,
          leakMarkers: c.expect.leakMarkers?.map(expand),
        };
        for (let run = 0; run < runs; run++) {
          const started = Date.now();
          try {
            const sources = await retrieveSources(user, { query: c.question });
            const outcome = await generateAnswerWithUsage(
              client,
              c.question,
              sources
            );
            const score = scoreCase(expectation, {
              answer: outcome.answer,
              citations: outcome.citations,
              sources: sources.map((s) => ({
                title: s.document.title,
                sections: s.sections,
              })),
            });
            results.push({
              case: c.id,
              stratum: c.stratum,
              run,
              ...score,
              answer: outcome.answer,
              droppedSegments: outcome.droppedSegments,
              usage: outcome.usage,
              latencyMs: Date.now() - started,
            });
          } catch (err) {
            results.push({
              case: c.id,
              stratum: c.stratum,
              run,
              pass: false,
              error: err instanceof Error ? err.message : String(err),
              latencyMs: Date.now() - started,
            });
          }
        }
      }
      const out = process.env.AI_ANSWERS_EVAL_OUT;
      if (out) {
        writeFileSync(
          out,
          JSON.stringify(
            { model: process.env.AI_ANSWERS_MODEL ?? "default", results },
            null,
            1
          )
        );
      }
      expect(results.length).toBeGreaterThan(0);
    },
    30 * 60_000
  );
});
