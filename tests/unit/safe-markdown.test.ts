import { sanitizeUrl, stripControlChars } from "@/components/markdown/SafeMarkdown";
import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

/**
 * SafeMarkdown (U6): untrusted message/summary/preview/error text must never
 * execute scripts, never keep dangerous link protocols, never emit terminal
 * control characters, and stay readable. Helpers are pure; rendering is
 * asserted via react-dom/server (no DOM needed).
 */

function render(content: string): string {
  return renderToStaticMarkup(createElement(SafeMarkdown, { content }));
}

describe("stripControlChars", () => {
  it("removes CSI sequences and keeps the visible text", () => {
    expect(stripControlChars("\x1b[31mred\x1b[0m plain")).toBe("red plain");
  });

  it("removes OSC sequences terminated by BEL and by ST", () => {
    expect(stripControlChars("\x1b]0;pwned\x07after")).toBe("after");
    expect(stripControlChars("\x1b]8;;http://evil\x1b\\link")).toBe("link");
  });

  it("removes C0/C1 controls but keeps newline and tab", () => {
    expect(stripControlChars("a\x00\x07\x1bb\x9bc\nd\te")).toBe("abc\nd\te");
  });
});

describe("sanitizeUrl", () => {
  it("allows http, https and mailto (case-insensitive scheme)", () => {
    expect(sanitizeUrl("https://example.com/x?y=1")).toBe("https://example.com/x?y=1");
    expect(sanitizeUrl("http://example.com")).toBe("http://example.com");
    expect(sanitizeUrl("MAILTO:a@b.c")).toBe("MAILTO:a@b.c");
  });

  it("neutralizes javascript:, data:, vbscript: and file:", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeUrl("data:text/html;base64,AAAA")).toBeNull();
    expect(sanitizeUrl("vbscript:msgbox(1)")).toBeNull();
    expect(sanitizeUrl("file:///etc/passwd")).toBeNull();
  });

  it("defeats tab/newline scheme obfuscation", () => {
    expect(sanitizeUrl("jav\tascript:alert(1)")).toBeNull();
    expect(sanitizeUrl("java\nscript:alert(1)")).toBeNull();
  });

  it("rejects schemeless and relative URLs", () => {
    expect(sanitizeUrl("//evil.example/x")).toBeNull();
    expect(sanitizeUrl("/local/path")).toBeNull();
    expect(sanitizeUrl("#anchor")).toBeNull();
  });
});

describe("SafeMarkdown rendering", () => {
  it("renders raw HTML (script, event handlers) as inert text", () => {
    const html = render("<script>alert(1)</script><img src=x onerror=alert(2)> plain");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img"); // no real img element (and no onerror attribute)
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;"); // only inert escaped text
    expect(html).toContain("alert(1)"); // escaped, still readable
    expect(html).toContain("plain");
  });

  it("neutralizes javascript: and data: links into plain text", () => {
    const html = render("[click](javascript:alert(1)) [x](data:text/html;base64,AAAA)");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(html).toContain("click");
    expect(html).toContain("x");
  });

  it("neutralizes entity-encoded javascript: links", () => {
    const html = render("[click](&#106;avascript:alert(1))");
    expect(html).not.toContain("<a");
    expect(html).toContain("click");
  });

  it("keeps safe links with isolation attributes", () => {
    const html = render("[ok](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener noreferrer ugc nofollow");
  });

  it("strips terminal control characters before rendering", () => {
    const html = render("\x1b[1m标题\x1b[0m 正文");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the escape char is gone
    expect(html).not.toMatch(/\x1b/);
    expect(html).toContain("标题");
    expect(html).toContain("正文");
  });

  it("degrades markdown images to alt text without loading them", () => {
    const html = render("![跟踪](https://evil.example/track.png)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("track.png");
    expect(html).toContain("跟踪");
  });

  it("renders GFM tables as table elements without raw HTML", () => {
    const html = render("| 角色 | run |\n| --- | --- |\n| planner_a | `a-0` |\n");
    expect(html).toContain("<table");
    expect(html).toContain("<th>");
    expect(html).toContain("planner_a");
    expect(html).not.toContain("<script");
  });
});
