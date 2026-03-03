# Question Tool UI Design

Date: 2026-03-03  
Status: Proposed

## Goal

Add a `Question` tool so the agent can ask users follow-up questions inside the chat flow, without breaking context.

## Design Options

### Option A (Recommended): Inline Tool Card in Message

- Reuse the current `ToolCallCard` container in assistant messages.
- Render a special question interaction block when tool result contains a question payload.
- User answers directly in the card.

Why recommend:

- Fits existing tool-call mental model.
- Lowest implementation and QA risk.
- Keeps history/audit trail in the same message thread.

### Option B: Composer-Attached Prompt Bar

- Show question above chat input area.
- User answers in composer-level widget.

Tradeoff:

- Cleaner message area, but split attention between message and composer.
- More state coordination with `ChatInput`.

### Option C: Modal Dialog

- Pop up modal for required question.

Tradeoff:

- Strong focus, but interrupts flow.
- Worse for long chats and repeated tool interactions.

## Recommended Visual Style (Option A)

### Card Layout

1. Header row
- Left icon: `HelpCircle` (question identity)
- Title: `Question`
- Status badge:
  - `Waiting for answer` (pending)
  - `Answered` (resolved)

2. Question body
- Primary text block for the question sentence
- Optional hint/description in muted text

3. Answer controls
- Optional single-choice chips/buttons
- Optional free-text input
- Primary action: `Send Answer`
- Secondary action: `Skip`

4. Resolved summary
- Once submitted, collapse controls and show:
  - `You answered: ...`

### Tone and Color

- Pending question card:
  - Border: slightly emphasized info border
  - Background: light info tint (`bg-blue-50/40` style)
- Resolved:
  - Neutral/success subtle background
- Keep all typography consistent with existing tool cards (`text-xs`, `text-sm` scale).

### Spacing and Sizing

- Match current `ToolCallCard` rhythm:
  - Outer padding `p-3`
  - Internal sections separated by `space-y-2`
- Buttons/chips:
  - Min height 32px
  - Wrap to next line on small width

### Motion

- Use existing fade-in behavior from message list.
- Add optional subtle pulse to pending status dot (not the whole card).

## Interaction Rules

1. Default state: expanded when question is pending.
2. Required question:
- Keep submit disabled until a valid answer exists.
3. Optional question:
- Allow `Skip`.
4. Prevent duplicate submit:
- Disable controls while sending.
5. After submit:
- Mark as resolved and hide input controls.

## Suggested Payload Shape

Tool input:

```json
{
  "question": "Which environment should I deploy to?",
  "choices": ["staging", "production"],
  "allowFreeText": false,
  "required": true,
  "placeholder": "Type your answer",
  "submitLabel": "Send Answer"
}
```

Question-request result payload (for renderer parsing):

```json
{
  "kind": "question_request",
  "toolCallId": "tool_xxx",
  "question": "Which environment should I deploy to?",
  "choices": ["staging", "production"],
  "allowFreeText": false,
  "required": true,
  "placeholder": "Type your answer",
  "submitLabel": "Send Answer"
}
```

Transport prefix suggestion:

`__tool_question__:<json>`

## Component-Level Implementation Mapping

- `src/api/services/ai/tools/definitions.ts`
  - Add `Question` tool definition and schema.
- `src/api/services/ai/tools/executor.ts`
  - Add `Question` execution branch returning standardized question payload.
- `src/renderer/src/components/chat/ToolCallCard.tsx`
  - Parse `__tool_question__` payload.
  - Render question-style controls.
- `src/renderer/src/stores/chatStore.ts`
  - Add action to submit answer back into conversation (deterministic tagged message).
- `src/renderer/src/components/chat/__tests__/ToolCallCard.test.tsx`
  - Add pending/resolved question UI tests.

## Accessibility

- Ensure chips and submit button are keyboard reachable.
- `Enter` submits when valid.
- Use visible focus ring on input/buttons.
- Status text should not rely on color alone.

## Mobile Notes

- Controls stack vertically on narrow width.
- Submit/Skip buttons become full-width on small screens.
- Keep question text max width readable (`break-words` + adequate line-height).

