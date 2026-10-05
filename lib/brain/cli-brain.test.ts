import { describe, it, expect } from "vitest";
import { extractJson, parseCliEngine, isCliEngine, cliBrainDef, CLI_BRAINS } from "./cli-brain";

/**
 * `extractJson` is the load-bearing piece of the CLI-brain integration: agentic
 * CLIs wrap answers in prose and fences no matter how firmly the prompt says not
 * to, so every structured caller depends on this recovering the payload.
 */
describe("extractJson", () => {
  it("parses a bare object or array", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("unwraps a ```json fence", () => {
    expect(extractJson('```json\n{"shots":[]}\n```')).toEqual({ shots: [] });
    expect(extractJson("```\n[1]\n```")).toEqual([1]);
  });

  it("ignores prose before and after — the common CLI failure mode", () => {
    const raw = `Sure! Here is the plan you asked for:

\`\`\`json
{"shots":[{"q":"city at night"}]}
\`\`\`

Let me know if you'd like changes.`;
    expect(extractJson(raw)).toEqual({ shots: [{ q: "city at night" }] });
  });

  it("does not stop at a brace inside a string", () => {
    // A naive indexOf('}') would truncate here and produce malformed JSON.
    expect(extractJson('{"text":"a } b { c","n":2}')).toEqual({ text: "a } b { c", n: 2 });
  });

  it("handles escaped quotes inside strings", () => {
    expect(extractJson('{"t":"say \\"hi\\" }"}')).toEqual({ t: 'say "hi" }' });
  });

  it("handles nested structures", () => {
    const v = extractJson<{ a: { b: number[] } }>('prefix {"a":{"b":[1,{"c":2}]}} suffix');
    expect(v.a.b[0]).toBe(1);
  });

  it("throws a humane error when there is no JSON at all", () => {
    expect(() => extractJson("I cannot help with that.")).toThrow(/did not return JSON/i);
  });

  it("throws when the JSON is truncated", () => {
    expect(() => extractJson('{"a":1')).toThrow(/incomplete/i);
  });

  it("throws when the JSON is malformed", () => {
    expect(() => extractJson("{'a': 1}")).toThrow(/malformed/i);
  });
});

describe("engine id parsing", () => {
  it("round-trips every registered brain", () => {
    for (const b of CLI_BRAINS) {
      expect(parseCliEngine(`cli:${b.id}`)).toBe(b.id);
      expect(isCliEngine(`cli:${b.id}`)).toBe(true);
      expect(cliBrainDef(b.id)?.label).toBe(b.label);
    }
  });

  it("rejects other engine namespaces", () => {
    for (const id of ["local:llama3.2", "platform:openai", "auto", "local", ""]) {
      expect(parseCliEngine(id)).toBeNull();
      expect(isCliEngine(id)).toBe(false);
    }
  });

  it("rejects an unknown cli id rather than passing it to Rust", () => {
    expect(parseCliEngine("cli:not-a-real-brain")).toBeNull();
  });
});
