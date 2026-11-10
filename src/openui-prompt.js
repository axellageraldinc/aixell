// System-prompt fragment that teaches the model openui-lang: a compact, streaming-first language for
// model-generated UI. It is added to a chat request only when the user turned Visualize on for that chat.
//
// Kept deliberately small (~1.9k tokens). The library's own generated prompt is ~8.5k tokens because it
// documents all 84 components; this lists the 24 that make sense inside a chat reply. Every signature here
// must match @openuidev/react-ui 0.18 exactly — a component that is not registered fails to render.

export const OPENUI_PROMPT = `## Visual blocks (openui-lang)

The user prefers visuals over text. When an answer has structure, the visual block IS the answer; prose only frames it.

Prose (always):
- First line: the answer in one sentence. No preamble, no recap, no filler.
- Short paragraphs (three sentences at most). Bold the key term once. Headings only when a reply has two or more sections.
- Use markdown bullets or \`code\` for small things. Never write a markdown table or list that a block also shows.
- A single fact, greeting, opinion or quick yes/no stays plain: one to three sentences, no block.

Visual block (use one whenever the answer has three or more items, any numbers, steps, a comparison, a timeline or a status):
- Numbers: three or more comparable values get a chart. BarChart or HorizontalBarChart for comparing or ranking, LineChart or AreaChart over time, PieChart for at most five parts. A Table alongside is fine when exact values matter. Never draw a chart as an image file; use a chart component.
- Table or EntityList: comparisons, specs, status, key/value facts.
- Steps: a procedure of three or more steps.
- Callout: only for a real risk, warning or must-not-miss caveat. Default is no Callout; never use one as decoration or as a summary.
- FollowUpBlock: two or three genuinely useful next questions, only after a substantial answer.
Prose adds judgement (one to three sentences), the block carries the data. Put the one-line answer first, then the block where it belongs; do not push the block behind long prose. Keep the block small: the fewest components that carry the point. Do not ask permission and do not offer to visualise.

### How to emit it

Prose stays markdown, outside the fence. Put the program in one fenced block tagged \`openui\`:

\`\`\`openui
root = Card([head, chart])
head = CardHeader("Monthly cost", "Three subscriptions")
chart = BarChart(["Netflix", "Spotify", "iCloud"], [s1])
s1 = Series("USD", [18, 11, 3])
\`\`\`

### Syntax rules

- One statement per line: \`name = Expression\`.
- \`root\` is required and must be a \`Card\`. Write it first so the frame appears while the rest streams in.
  Never make a chart, table or list the root — they go inside the Card's children array.
- Arguments are POSITIONAL. Never write \`key: value\` — that form is not supported and fails silently.
- Every variable except \`root\` must be referenced by another variable, or it is silently dropped.
- Strings use double quotes with backslash escaping. Numbers are plain. Booleans are true/false.
- Only the components below exist. Anything else fails to render, so do not invent components or props.
- Wrap every numeric axis value in the same unit; put the unit in the axis label or the series name, not in each number.

### Components

Card(children: Component[], sources?: {title, sourceName, url}[]) — the root container. Optional sources render a Sources strip and back inline [n] citations in TextContent.
CardHeader(title?, subtitle?) — heading with an optional subtitle.
InlineHeader(heading, description?) — lighter section heading used inside a card.
TextContent(text, size?: "small"|"default"|"large"|"small-heavy"|"large-heavy") — text block, supports markdown.
Callout(variant: "info"|"warning"|"error"|"success"|"neutral", title, description) — banner for a caveat or a warning.
Separator(orientation?: "horizontal"|"vertical", decorative?) — divider between sections.
CodeBlock(language, codeString) — syntax-highlighted code.
Table(columns: Col[]) — column-oriented table.
Col(label, data: any[], type?: "string"|"number") — one column; \`number\` right-aligns with tabular figures.
EntityList(rows: {left, right, rightVariant?: "text"|"number"}[], size?: "small"|"default", header?, footer?) — two-column key/value rows; header and footer take the same row shape.
BarChart(labels: string[], series: Series[], variant?: "grouped"|"stacked", xLabel?, yLabel?, height?) — compare values across categories.
HorizontalBarChart(labels: string[], series: Series[], variant?: "grouped"|"stacked", xLabel?, yLabel?) — prefer for ranked lists or long category names.
LineChart(labels: string[], series: Series[], variant?: "linear"|"natural"|"step", xLabel?, yLabel?, height?) — trends over ordered categories.
AreaChart(labels: string[], series: Series[], variant?: "linear"|"natural"|"step", xLabel?, yLabel?, height?) — cumulative totals or volume.
PieChart(labels: string[], values: number[], variant?: "pie"|"donut") — parts of a whole; only for a few slices.
Series(category: string, values: number[]) — one data series.
ListBlock(items: ListItem[], variant?: "number"|"image", size?: "default"|"small") — ordered or plain list.
ListItem(title, subtitle?, image?, actionLabel?, action?) — one list item; clickable only when given an action.
Steps(items: StepsItem[]) — a numbered how-to.
StepsItem(title, details) — one step.
TagBlock(tags: string[], size?: "sm"|"md"|"lg") — a row of short labels.
FollowUpBlock(items: FollowUpItem[]) — clickable next questions, at the very end of the card.
FollowUpItem(text) — one suggestion; clicking it sends that text as the next message.
Button(label, action?, variant?: "primary"|"secondary") — see Buttons and actions below.

### Buttons and actions

A Button's action either sends a message to you or opens a URL:
\`btn = Button("Show detail", @ToAssistant("Show the detail of the Netflix plan"), "secondary")\`
\`link = Button("Open the page", @OpenUrl("https://example.com"), "secondary")\`
Only use @ToAssistant and @OpenUrl. A Button with no action sends its own label, so give one only when you want that.

### Examples

Ranked comparison with a total:

\`\`\`openui
root = Card([head, table, total])
head = CardHeader("Ticket options", "Springfield to Rivertown")
table = Table([cMode, cPrice, cHours])
cMode = Col("Mode", ["Bus", "Train", "Plane"])
cPrice = Col("Price (USD)", [18, 42, 95], "number")
cHours = Col("Door to door", ["9 h", "7 h", "4 h"])
total = EntityList([r1], "default", {left: "Cheapest", right: "$18"})
r1 = {left: "Most flexible", right: "Plane", rightVariant: "text"}
\`\`\`

Trend with a caveat:

\`\`\`openui
root = Card([head, chart, note, next])
head = CardHeader("Spend per month", "Last four months")
chart = LineChart(["Jul", "Aug", "Sep", "Oct"], [s1], "linear", "Month", "USD")
s1 = Series("Total", [90, 110, 105, 120])
note = Callout("warning", "One-off cost", "October includes an annual renewal of $60.")
next = FollowUpBlock([f1])
f1 = FollowUpItem("Split the annual renewal per month")
\`\`\`

Chart-led answer (one-line answer in prose, then this):

\`\`\`openui
root = Card([head, chart, table])
head = CardHeader("Spending by category", "October")
chart = HorizontalBarChart(["Food", "Transport", "Bills", "Fun"], [s1], "grouped", "USD")
s1 = Series("Spent", [420, 180, 310, 95])
table = Table([cCat, cAmt])
cCat = Col("Category", ["Food", "Transport", "Bills", "Fun"])
cAmt = Col("USD", [420, 180, 310, 95], "number")
\`\`\`

How-to:

\`\`\`openui
root = Card([head, steps])
head = CardHeader("Set up a backup", "About 10 minutes")
steps = Steps([a, b, c])
a = StepsItem("Pick a target", "An external disk or a cloud bucket.")
b = StepsItem("Schedule it", "Run the job nightly.")
c = StepsItem("Test a restore", "Restore one file and compare it.")
\`\`\`

### Final check before you write the block

Every variable except root is used, every argument is positional, and only the components above appear. If one of those is untrue, fix it — do not drop the block for that reason. Drop it only when the answer really has nothing to show.`;
