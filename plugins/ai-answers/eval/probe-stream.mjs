// Prints when each Server-Sent Event of /api/ai.ask arrives, to check after a
// deploy that the proxy (Caddy) does not buffer the stream: events should
// arrive spread over the answer, not all at once at the end.
//
// It makes one real AI request, which is metered against the workspace budget.
// Event payloads are not printed (only names, phases and sizes); the key is
// never printed.
//
// Usage, from the repo root:
//   AI_PROBE_BASE_URL=https://docs.example.com AI_PROBE_API_KEY=ol_api_... \
//     [AI_PROBE_QUERY="How many days of holiday?"] \
//     node plugins/ai-answers/eval/probe-stream.mjs

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const base = process.env.AI_PROBE_BASE_URL;
const key = process.env.AI_PROBE_API_KEY;
const query = process.env.AI_PROBE_QUERY || "What is this workspace about?";
if (!base || !key) {
  fail(
    "Refusing to run: set AI_PROBE_BASE_URL and AI_PROBE_API_KEY explicitly."
  );
}
let url;
try {
  url = new URL("/api/ai.ask", base);
} catch {
  fail("Refusing to run: AI_PROBE_BASE_URL is not a valid URL.");
}
if (
  !["http:", "https:"].includes(url.protocol) ||
  url.username ||
  url.password
) {
  fail(
    "Refusing to run: AI_PROBE_BASE_URL must be http(s) without credentials."
  );
}

const startedAt = Date.now();
const stamp = () => `+${String(Date.now() - startedAt).padStart(6)} ms`;
const res = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  },
  body: JSON.stringify({ query }),
});
console.log(
  `${stamp()}  HTTP ${res.status}  content-type=${res.headers.get("content-type")}  content-encoding=${res.headers.get("content-encoding") ?? "none"}`
);
if (!res.ok || !res.body) {
  fail(
    "No event stream; check the URL, the key and that AI answers are enabled."
  );
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let end;
  while ((end = buffer.indexOf("\n\n")) !== -1) {
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    if (frame.startsWith(":")) {
      console.log(`${stamp()}  (heartbeat)`);
      continue;
    }
    const event = /^event: (.*)$/m.exec(frame)?.[1] ?? "message";
    const data = /^data: (.*)$/m.exec(frame)?.[1] ?? "";
    let detail = `${data.length} bytes`;
    if (event === "status" || event === "failed") {
      try {
        const parsed = JSON.parse(data);
        detail = parsed.phase ?? parsed.reason ?? detail;
      } catch {
        // Keep the size only.
      }
    }
    console.log(`${stamp()}  ${event.padEnd(12)} ${detail}`);
  }
}
console.log(`${stamp()}  stream closed`);
