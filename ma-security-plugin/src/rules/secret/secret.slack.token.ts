// Slack token: bot, user, app-level, and legacy workspace tokens.
import type { RedactRule } from "../types.ts"

// Gen adds random chars only at the end, so the numeric head is fixed filler.
const BOT_HEAD = "xoxb-1234567890-1234567890123-"
const USER_HEAD = "xoxp-1234567890-1234567890-1234567890123-"
const APP_HEAD = "xapp-1-A0123456789-1234567890123-"

export default {
  id: "secret.slack.token",
  family: "secret",
  kind: "slack.token",
  severity: "critical",
  gate: "keyword",
  keywords: ["xoxb-", "xoxp-", "xoxa-", "xoxe-", "xapp-"],
  pattern: String.raw`(?<![A-Za-z0-9_-])(?:xox[bpae]-[0-9]{10,13}(?:-[0-9]{10,13}){1,2}-[A-Za-z0-9]{24,64}|xapp-[0-9]-[A-Z0-9]{9,12}-[0-9]{10,13}-[a-z0-9]{32,80})(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  explain: "Slack token (xoxb-, xoxp-, xoxa-, xoxe-, xapp-). Acts as a bot, user, or app.",
  render: { keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "SLACK_BOT_TOKEN={{S}}",
        secret: { prefix: BOT_HEAD, len: 24, charset: "alnum", seed: 2701 },
      },
      { text: "'{{S}}'", secret: { prefix: USER_HEAD, len: 32, charset: "alnum", seed: 2702 } },
      {
        text: "SLACK_APP_TOKEN={{S}}",
        secret: { prefix: APP_HEAD, len: 64, charset: "hex", seed: 2703 },
      },
    ],
    not_match: [
      "bot tokens start with xoxb- and app tokens with xapp-",
      { text: "{{S}}", secret: { prefix: BOT_HEAD, len: 23, charset: "alnum", seed: 2704 } },
      { text: "{{S}}#", secret: { prefix: BOT_HEAD, len: 24, charset: "alnum", seed: 2705 } },
      {
        text: "{{S}}",
        secret: { prefix: "xoxz-1234567890-1234567890123-", len: 24, charset: "alnum", seed: 2706 },
      },
    ],
  },
  inspiredBy: {
    tool: "gitleaks",
    ruleId: "slack-bot-token",
    url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
  },
  notes:
    "publicPrefix unset: five prefixes in one rule. Also after gitleaks slack-user-token and slack-app-token.",
} satisfies RedactRule
