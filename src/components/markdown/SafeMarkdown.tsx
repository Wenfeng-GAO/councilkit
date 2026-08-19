import ReactMarkdown, { type Components, type Options } from "react-markdown";

/**
 * SafeMarkdown (U6): the ONLY renderer for untrusted text (Message bodies,
 * Summaries, streaming previews, activity/error text).
 *
 * Hardening contract:
 * - react-markdown WITHOUT rehype-raw: raw HTML in the source is parsed as
 *   text and escaped by React, so <script>/on* attributes/SVG are inert.
 * - No `dangerouslySetInnerHTML` anywhere in this file or its callers.
 * - Link destinations pass `sanitizeUrl`: only http:, https: and mailto:
 *   survive; everything else (javascript:, data:, vbscript:, relative…)
 *   renders as plain text. External links get isolation attributes.
 * - Terminal control characters (CSI/OSC sequences, C0/C1 controls except
 *   \n and \t) are stripped BEFORE rendering, so model output cannot smuggle
 *   terminal escapes into copied text or obfuscate URLs.
 * - Images never load (no third-party requests from untrusted output);
 *   they degrade to their alt text.
 */

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/unit/safe-markdown.test.ts)
// ---------------------------------------------------------------------------

// CSI: ESC [ parameter-bytes intermediate-bytes final-byte.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control characters is the purpose of this sanitizer
const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// OSC: ESC ] payload, terminated by BEL or ST (ESC \). Unterminated OSC loses
// only its opener; the payload survives as harmless plain text once the C0
// pass below removes the ESC.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control characters is the purpose of this sanitizer
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
// Remaining C0 controls except \n (0x0A) and \t (0x09), plus DEL and the C1
// range (8-bit CSI/NEL and friends).
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control characters is the purpose of this sanitizer
const C0_C1_PATTERN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** Remove terminal control characters/sequences from untrusted display text. */
export function stripControlChars(text: string): string {
  return text.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "").replace(C0_C1_PATTERN, "");
}

const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

/**
 * Allow only http:/https:/mailto: link destinations. Returns the cleaned URL
 * when safe, otherwise null (caller renders the label as plain text). Tabs
 * and newlines are removed before scheme detection because browsers ignore
 * them inside the scheme ("jav&#x09;ascript:"-style obfuscation).
 */
export function sanitizeUrl(url: string): string | null {
  const cleaned = url.replace(/[\t\n\r]/g, "").trim();
  const colon = cleaned.indexOf(":");
  if (colon <= 0) return null; // no explicit safe scheme → not a link
  const scheme = cleaned.slice(0, colon).toLowerCase();
  if (!SAFE_SCHEMES.has(scheme)) return null;
  return cleaned;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const urlTransform: NonNullable<Options["urlTransform"]> = (url) => sanitizeUrl(url) ?? "";

const components: Components = {
  a: (props) => {
    const { node: _node, href, children } = props;
    if (!href) {
      // Neutralized destination (javascript:/data:/relative…): plain text.
      return <span>{children}</span>;
    }
    const isMailto = href.toLowerCase().startsWith("mailto:");
    return (
      <a
        href={href}
        className="text-accent underline"
        target={isMailto ? undefined : "_blank"}
        rel="noopener noreferrer ugc nofollow"
      >
        {children}
      </a>
    );
  },
  img: (props) => {
    // Never fetch untrusted image URLs: degrade to the alt text.
    const { node: _node, alt } = props;
    return <span className="text-muted">[图片{alt ? `：${alt}` : ""}]</span>;
  },
};

interface SafeMarkdownProps {
  /** Untrusted markdown source (message / summary / preview / error text). */
  content: string;
  className?: string;
  /** `document` adds heading/list/code chrome for long reports. Default stays compact. */
  variant?: "inline" | "document";
}

export function SafeMarkdown({ content, className = "", variant = "inline" }: SafeMarkdownProps) {
  return (
    <div
      className={`break-words leading-relaxed ${variant === "document" ? "ck-doc" : ""} ${className}`}
    >
      <ReactMarkdown urlTransform={urlTransform} components={components}>
        {stripControlChars(content)}
      </ReactMarkdown>
    </div>
  );
}
