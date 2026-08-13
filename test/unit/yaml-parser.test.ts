import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseYaml } from "../../src/yaml-parser.js";

function jsonValue(text: string): unknown {
  const value = parseYaml(text);
  assert.notEqual(value, undefined);
  return JSON.parse(JSON.stringify(value));
}

describe("parseYaml", () => {
  it("handles BOM, CRLF, comments, and comment-like scalar text", () => {
    assert.deepEqual(jsonValue("\ufeffroot:\r\n  url: https://example.test/a#b # comment\r\n  hash: \"#quoted\" # comment\r\n  apostrophe: It's valid\r\n"), {
      root: {
        url: "https://example.test/a#b",
        hash: "#quoted",
        apostrophe: "It's valid",
      },
    });
  });

  it("resolves YAML 1.2 core scalar values without YAML 1.1 aliases", () => {
    const parsed = parseYaml(`
      values:
        null_lower: null
        null_tilde: ~
        true_lower: true
        true_title: True
        false_upper: FALSE
        yes: yes
        no: NO
        on: on
        off: OFF
        decimal: -12_345
        octal: 0o17
        hexadecimal: +0x2a
        float: 1_000.25e-1
        infinity: .inf
        negative_infinity: -.Inf
        not_a_number: .NAN
        quoted_number: "0123"
    `) as { values: Record<string, unknown> };
    assert.equal(parsed.values.infinity, Infinity);
    assert.equal(parsed.values.negative_infinity, -Infinity);
    assert.equal(Number.isNaN(parsed.values.not_a_number as number), true);
    assert.deepEqual(parsed, {
      values: {
        null_lower: null,
        null_tilde: null,
        true_lower: true,
        true_title: true,
        false_upper: false,
        yes: "yes",
        no: "NO",
        on: "on",
        off: "OFF",
        decimal: -12345,
        octal: 15,
        hexadecimal: 42,
        float: 100.025,
        infinity: Infinity,
        negative_infinity: -Infinity,
        not_a_number: NaN,
        quoted_number: "0123",
      },
    });
  });

  it("strips comments inside flow collections without touching quoted hashes", () => {
    assert.deepEqual(jsonValue("document: [one, # comment\n  '#kept', {value: \"#also-kept\"}]"), {
      document: ["one", "#kept", { value: "#also-kept" }],
    });
  });

  it("strips comments after apostrophes in plain scalars", () => {
    assert.deepEqual(jsonValue("description: It's valid # comment\n"), {
      description: "It's valid",
    });
  });

  it("keeps hashes in quoted sequence values", () => {
    assert.deepEqual(jsonValue("items:\n  - '#kept' # comment\n"), {
      items: ["#kept"],
    });
  });

  it("handles compact flow mappings without a space after ':', like JSON", () => {
    assert.deepEqual(jsonValue('document: {"a":1,b:{"c":[2,3]}}'), {
      document: { a: 1, b: { c: [2, 3] } },
    });
  });

  it("decodes quoted escapes and preserves plain scalar punctuation", () => {
    assert.deepEqual(jsonValue(`
      double: "line\\n\\t\\u263A\\x21"
      single: 'a ''quoted'' value'
      punctuation: http://example.test/?a=1:2#fragment
      colon: value:with:colons
      dash: -not-a-sequence
      question: ?not-a-key-marker
    `), {
      double: "line\n\t☺!",
      single: "a 'quoted' value",
      punctuation: "http://example.test/?a=1:2#fragment",
      colon: "value:with:colons",
      dash: "-not-a-sequence",
      question: "?not-a-key-marker",
    });
  });

  it("handles nested flow collections, quoted colons, and trailing commas", () => {
    assert.deepEqual(jsonValue(`
      document: {
        \"key: with colon\": [one, {two: \"three: four\"}],
        empty_map: {},
        empty_sequence: [],
        trailing: [one, two,],
      }
    `), {
      document: {
        "key: with colon": ["one", { two: "three: four" }],
        empty_map: {},
        empty_sequence: [],
        trailing: ["one", "two"],
      },
    });
  });

  it("handles block sequences, compact sequence mappings, and null entries", () => {
    assert.deepEqual(jsonValue(`
      items:
        - name: first
          values:
            - 1
            - 2
        - name: second
          empty:
        -
          name: third
        - null
    `), {
      items: [
        { name: "first", values: [1, 2] },
        { name: "second", empty: null },
        { name: "third" },
        null,
      ],
    });
  });

  it("preserves literal and folded scalar semantics", () => {
    assert.deepEqual(jsonValue(`
      literal: |-
        first
        second

        fourth
      keep: |+
        one

      folded: >-
        first
        second

        fourth
      indented: >-
        first
          code
        last
    `), {
      literal: "first\nsecond\n\nfourth",
      keep: "one\n\n",
      folded: "first second\nfourth",
      indented: "first\n  code\nlast",
    });
  });

  it("preserves comments, brackets, and blank lines inside block scalars", () => {
    assert.deepEqual(jsonValue(`
      text: |-
        # this is text, not a YAML comment
        [literal
        ...
        ---
        %not-a-directive

        after blank
    `), {
      text: "# this is text, not a YAML comment\n[literal\n...\n---\n%not-a-directive\n\nafter blank",
    });
  });

  it("supports explicit block scalar indentation", () => {
    assert.deepEqual(jsonValue(`
      text: |2-
          two spaces are content
        one space is removed
    `), {
      text: "  two spaces are content\none space is removed",
    });
  });

  it("handles special object keys without prototype pollution", () => {
    const value = parseYaml(`
      __proto__: polluted
      constructor: constructor-value
      prototype: prototype-value
    `) as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(value, "__proto__"), true);
    assert.equal(value["__proto__"], "polluted");
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
    assert.equal(value.constructor, "constructor-value");
    assert.equal(value.prototype, "prototype-value");
  });

  it("supports document markers but rejects document streams and directives", () => {
    assert.deepEqual(jsonValue("# heading\n---\nvalue: 1\n...\n"), { value: 1 });
    assert.throws(() => parseYaml("---\na: 1\n---\nb: 2\n"), /Multiple YAML documents/);
    assert.throws(() => parseYaml("%YAML 1.2\n---\na: 1\n"), /directives/);
    assert.throws(() => parseYaml("...\n"), /before content|empty/);
  });

  it("rejects malformed quoting, flow syntax, indentation, and unsupported features", () => {
    const invalidDocuments = [
      "key: [unclosed",
      "key: {unclosed",
      "key: {a: 1]",
      "key: \"unclosed",
      "key: 'unclosed",
      "key: \"bad\\q\"",
      "key: *anchor",
      "key: &anchor value",
      "key: !custom value",
      "key:\n\tvalue",
      "- first\n  second",
      "key: ]",
      "key: {\"unterminated: 1}",
      "key: {a: 1]",
      "key: [a, b",
      "key: value\n- sequence-item",
      "key:\n  nested: 1\n key2: 2",
    ];
    for (const document of invalidDocuments) {
      assert.throws(() => parseYaml(document), document);
    }
  });

  it("enforces all parser limits", () => {
    assert.throws(() => parseYaml("a:\n  b:\n    c: 1", { maxDepth: 2 }), /nesting/);
    assert.throws(() => parseYaml("a: 1\nb: 2", { maxNodes: 1 }), /node count/);
    assert.throws(() => parseYaml("a: 1", { maxDepth: 0 }), /maxDepth/);
    assert.throws(() => parseYaml("a: 1", { maxNodes: 0 }), /maxNodes/);
    assert.throws(() => parseYaml("a: 1", { maxDepth: 1.5 }), /maxDepth/);
    assert.throws(() => parseYaml("a: 1", { maxNodes: Number.POSITIVE_INFINITY }), /maxNodes/);
    assert.throws(() => parseYaml(`a: ${"[".repeat(257)}1${"]".repeat(257)}`), /Flow nesting/);
    const nestedFlow = parseYaml(`a: ${"[".repeat(200)}1${"]".repeat(200)}`) as Record<string, unknown>;
    assert.equal(JSON.stringify(nestedFlow).includes("1"), true);
  });

  it("parses a deterministic corpus of generated API-shaped documents", () => {
    for (let index = 0; index < 100; index += 1) {
      const parsed = parseYaml(`
        openapi: 3.1.0
        info:
          title: API ${index}
          version: ${index}.0.0
        tags:
          - name: tag-${index}
            description: description-${index}
        paths:
          /items/${index}:
            get:
              operationId: listItems${index}
              responses:
                "200":
                  description: ok
                  content:
                    application/json:
                      schema: { type: array, items: { type: string } }
      `) as Record<string, unknown>;
      const info = parsed.info as Record<string, unknown>;
      const paths = parsed.paths as Record<string, unknown>;
      assert.equal(info.title, `API ${index}`);
      assert.equal(Object.keys(paths).length, 1);
      assert.equal(JSON.stringify(parsed).includes(`listItems${index}`), true);
    }
  });

  it("never recurses for a deeply nested document within its configured limit", () => {
    const depth = 200;
    const lines: string[] = [];
    for (let index = 0; index < depth; index += 1) {
      lines.push(`${" ".repeat(index * 2)}level${index}:`);
    }
    lines.push(`${" ".repeat(depth * 2)}value: done`);
    const parsed = parseYaml(lines.join("\n"), { maxDepth: depth + 2 });
    assert.equal(typeof parsed, "object");
    assert.equal(JSON.stringify(parsed).includes("done"), true);
  });
});
