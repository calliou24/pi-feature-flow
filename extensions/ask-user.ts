import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Option { value: string; label: string; description?: string }
interface Question {
  id: string;
  label: string;
  prompt: string;
  options: Option[];
  multiSelect: boolean;
  required: boolean;
  allowFreeText: boolean;
  minSelections: number;
  maxSelections: number;
  freeTextPlaceholder?: string;
}
interface Answer { id: string; values: string[]; labels: string[]; wasCustom: boolean; skipped: boolean }
interface Result { questions: Question[]; answers: Answer[]; cancelled: boolean }
interface QuestionState { cursor: number; checked: Set<number>; answer?: Answer; draft: string; error?: string }
type RenderOption = Option & { isOther?: boolean };

const OptionSchema = Type.Object({
  value: Type.String(),
  label: Type.String(),
  description: Type.Optional(Type.String()),
});
const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique stable id for exactly one question." }),
  label: Type.Optional(Type.String({ description: "Short tab/review label for this question." })),
  prompt: Type.String({ description: "Exactly one focused question. Never combine two questions in one prompt." }),
  options: Type.Optional(Type.Array(OptionSchema, { description: "Choices for this question only. Omit for a free-text-only question." })),
  multiSelect: Type.Optional(Type.Boolean({ description: "Whether multiple listed options may be selected." })),
  required: Type.Optional(Type.Boolean({ description: "Defaults to true." })),
  allowFreeText: Type.Optional(Type.Boolean({ description: "Defaults to true. Keep true to show a Custom answer choice even when options are supplied." })),
  minSelections: Type.Optional(Type.Integer({ minimum: 0 })),
  maxSelections: Type.Optional(Type.Integer({ minimum: 1 })),
  freeTextPlaceholder: Type.Optional(Type.String()),
});
const Params = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 12, description: "One object per question. To batch three independent questions, provide three objects, each with its own prompt, options, and allowFreeText setting." }),
});

function errorResult(message: string): { content: Array<{ type: "text"; text: string }>; details: Result } {
  return { content: [{ type: "text", text: message }], details: { questions: [], answers: [], cancelled: true } };
}

/**
 * Standalone structured-questions tool. Ships as its own extension so it can be
 * enabled without the feature workflow (and filtered out independently).
 */
export default function askUser(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: "Ask one or multiple structured questions. Put exactly one question in each questions[] object; each object owns its own choices. Free text is supported alone or as a Custom answer alongside choices.",
    promptSnippet: "Ask structured questions: one question per questions[] item, with a Custom answer when choices may be incomplete",
    promptGuidelines: [
      "Use ask_user rather than guessing when requirements, scope, architecture, or approval is unclear.",
      "Never put two questions into one prompt. For a batch, create one questions[] object per independent question, with a unique id and that question's own options.",
      "Batch only independent questions that can be answered in any order. Ask dependent follow-ups in a later ask_user call after reading the prior answer.",
      "For choice questions, normally set allowFreeText: true and a useful freeTextPlaceholder so the user can choose Custom answer. Use allowFreeText: false only when answers must be strictly constrained.",
    ],
    parameters: Params,
    executionMode: "sequential",

    async execute(_id, params, _signal, _update, ctx) {
      if (ctx.mode !== "tui") return errorResult("UI unavailable: ask_user requires interactive Pi TUI mode.");

      const questions: Question[] = params.questions.map((raw, index) => {
        const required = raw.required !== false;
        const options = raw.options ?? [];
        const multiSelect = raw.multiSelect === true;
        const minSelections = multiSelect ? (raw.minSelections ?? (required ? 1 : 0)) : 0;
        const maxSelections = multiSelect ? (raw.maxSelections ?? Math.max(options.length, 1)) : Math.max(options.length, 1);
        return {
          id: raw.id,
          label: raw.label || `Q${index + 1}`,
          prompt: raw.prompt,
          options,
          multiSelect,
          required,
          allowFreeText: raw.allowFreeText !== false,
          minSelections,
          maxSelections,
          freeTextPlaceholder: raw.freeTextPlaceholder,
        };
      });

      const seenIds = new Set<string>();
      for (const question of questions) {
        if (seenIds.has(question.id)) return errorResult(`Duplicate question id: '${question.id}'.`);
        seenIds.add(question.id);
        if ((question.prompt.match(/\?/g) ?? []).length > 1) {
          return errorResult(`Question '${question.id}' appears to contain multiple questions. Put each question in its own questions[] object.`);
        }
        if (question.options.length === 0 && !question.allowFreeText) {
          return errorResult(`Question '${question.id}' has no options and disallows free text.`);
        }
        if (question.multiSelect && (question.minSelections > question.maxSelections || question.minSelections > question.options.length)) {
          return errorResult(`Question '${question.id}' has impossible selection limits.`);
        }
      }

      const result = await ctx.ui.custom<Result>((tui, theme, _keybindings, done) => {
        let step = 0;
        let mode: "select" | "editing" = "select";
        let reviewCursor = 0;
        let submitted = false;
        let cachedWidth: number | undefined;
        let cachedLines: string[] | undefined;
        const states: QuestionState[] = questions.map(() => ({ cursor: 0, checked: new Set(), draft: "" }));
        const editorTheme: EditorTheme = {
          borderColor: (text) => theme.fg("accent", text),
          selectList: {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          },
        };
        const editor = new Editor(tui, editorTheme);

        const invalidate = () => { cachedWidth = undefined; cachedLines = undefined; tui.requestRender(); };
        const currentQuestion = () => questions[step];
        const currentState = () => states[step];
        const optionsFor = (q: Question): RenderOption[] => [
          ...q.options,
          ...(q.allowFreeText ? [{ value: "__other__", label: "Custom answer…", isOther: true }] : []),
        ];
        const allRequiredAnswered = () => questions.every((q, index) => !q.required || Boolean(states[index]?.answer));
        const finish = (cancelled: boolean) => {
          if (submitted) return;
          submitted = true;
          done({ questions, answers: states.flatMap((state) => state.answer ? [state.answer] : []), cancelled });
        };
        const advance = () => {
          if (questions.length === 1) return finish(false);
          step = Math.min(step + 1, questions.length);
          mode = "select";
          invalidate();
        };
        const commitOption = (q: Question, state: QuestionState, option: RenderOption, optionIndex: number) => {
          state.answer = { id: q.id, values: [option.value], labels: [option.label], wasCustom: false, skipped: false };
          state.checked = new Set([optionIndex]);
          state.error = undefined;
          advance();
        };
        const commitMulti = (q: Question, state: QuestionState) => {
          if (state.checked.size < q.minSelections || state.checked.size > q.maxSelections) {
            state.error = `Choose between ${q.minSelections} and ${q.maxSelections} options.`;
            invalidate();
            return;
          }
          const selected = [...state.checked].sort((a, b) => a - b).flatMap((index) => q.options[index] ? [q.options[index]] : []);
          state.answer = { id: q.id, values: selected.map((item) => item.value), labels: selected.map((item) => item.label), wasCustom: false, skipped: false };
          state.error = undefined;
          advance();
        };
        const firstInvalidIndex = () => questions.findIndex((q, index) => q.required && !states[index]?.answer);

        editor.onSubmit = (value) => {
          const q = currentQuestion();
          const state = currentState();
          if (!q || !state) return;
          const trimmed = value.trim();
          if (!trimmed && q.required) {
            state.error = "A response is required.";
            mode = "select";
            invalidate();
            return;
          }
          if (!trimmed) {
            state.answer = { id: q.id, values: [], labels: [], wasCustom: true, skipped: true };
          } else {
            state.draft = trimmed;
            state.answer = { id: q.id, values: [trimmed], labels: [trimmed], wasCustom: true, skipped: false };
          }
          editor.setText("");
          state.error = undefined;
          advance();
        };

        const handleInput = (data: string) => {
          if (mode === "editing") {
            const state = currentState();
            if (matchesKey(data, Key.escape)) {
              if (state) state.draft = editor.getText();
              mode = "select";
              invalidate();
              return;
            }
            editor.handleInput(data);
            invalidate();
            return;
          }

          if (step === questions.length) {
            if (matchesKey(data, Key.escape)) return finish(true);
            if (matchesKey(data, Key.ctrl("enter"))) {
              if (allRequiredAnswered()) return finish(false);
              const invalid = firstInvalidIndex();
              if (invalid >= 0) { step = invalid; states[invalid]!.error = "Answer this required question before submitting."; }
              invalidate();
              return;
            }
            if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
              step = questions.length - 1;
              invalidate();
              return;
            }
            if (matchesKey(data, Key.up)) reviewCursor = Math.max(0, reviewCursor - 1);
            else if (matchesKey(data, Key.down)) reviewCursor = Math.min(questions.length, reviewCursor + 1);
            else if (matchesKey(data, Key.enter)) {
              if (reviewCursor < questions.length) step = reviewCursor;
              else if (allRequiredAnswered()) return finish(false);
              else {
                const invalid = firstInvalidIndex();
                if (invalid >= 0) { step = invalid; states[invalid]!.error = "Answer this required question before submitting."; }
              }
            }
            invalidate();
            return;
          }

          const q = currentQuestion();
          const state = currentState();
          if (!q || !state) return;
          const options = optionsFor(q);
          state.error = undefined;

          if (matchesKey(data, Key.escape)) return finish(true);
          if (questions.length > 1 && (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")))) {
            step = Math.max(0, step - 1);
            invalidate();
            return;
          }
          if (questions.length > 1 && (matchesKey(data, Key.right) || matchesKey(data, Key.tab))) {
            step = Math.min(questions.length, step + 1);
            invalidate();
            return;
          }
          if (!q.required && data.toLowerCase() === "s") {
            state.answer = { id: q.id, values: [], labels: [], wasCustom: false, skipped: true };
            return advance();
          }
          if (matchesKey(data, Key.up)) state.cursor = Math.max(0, state.cursor - 1);
          else if (matchesKey(data, Key.down)) state.cursor = Math.min(Math.max(options.length - 1, 0), state.cursor + 1);
          else if (q.multiSelect && matchesKey(data, Key.space)) {
            if (state.cursor < q.options.length) {
              if (state.checked.has(state.cursor)) state.checked.delete(state.cursor); else state.checked.add(state.cursor);
            }
          } else if (matchesKey(data, Key.enter)) {
            const option = options[state.cursor];
            if (!option) return;
            if (option.isOther) {
              mode = "editing";
              editor.setText(state.draft);
            } else if (q.multiSelect) commitMulti(q, state);
            else commitOption(q, state, option, state.cursor);
          } else if (/^[1-9]$/.test(data)) {
            const index = Number(data) - 1;
            const option = options[index];
            if (option) {
              state.cursor = index;
              if (!q.multiSelect && !option.isOther) commitOption(q, state, option, index);
            }
          }
          invalidate();
        };

        const render = (width: number): string[] => {
          if (cachedLines && cachedWidth === width) return cachedLines;
          const w = Math.max(1, width);
          const lines: string[] = [];
          const addPrefixed = (prefix: string, text: string) => {
            const prefixWidth = visibleWidth(prefix);
            if (prefixWidth >= w) {
              lines.push(truncateToWidth(`${prefix}${text}`, w, ""));
              return;
            }
            const wrapped = wrapTextWithAnsi(text, w - prefixWidth);
            wrapped.forEach((line, index) => lines.push(truncateToWidth(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`, w, "")));
          };
          lines.push(theme.fg("accent", "─".repeat(w)));

          if (questions.length > 1) {
            const tabs = questions.map((q, index) => {
              const marker = states[index]?.answer ? "■" : "□";
              const label = ` ${marker} ${q.label} `;
              return index === step ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(states[index]?.answer ? "success" : "muted", label);
            });
            const submit = step === questions.length ? theme.bg("selectedBg", theme.fg("text", " ✓ Submit ")) : theme.fg(allRequiredAnswered() ? "success" : "dim", " ✓ Submit ");
            const tabLine = `← ${tabs.join(" ")} ${submit} →`;
            if (visibleWidth(tabLine) <= w - 2) addPrefixed(" ", tabLine);
            else {
              const label = step === questions.length ? "Review" : questions[step]!.label;
              const markers = questions.map((_, index) => states[index]?.answer ? "■" : index === step ? "□" : "·").join("");
              addPrefixed(" ", theme.fg("muted", `${step === questions.length ? "Review" : `Question ${step + 1} of ${questions.length}`} · ${label} [${markers}]`));
            }
            lines.push("");
          }

          if (step === questions.length) {
            addPrefixed(" ", theme.fg("accent", theme.bold("Review answers")));
            lines.push("");
            questions.forEach((q, index) => {
              const answer = states[index]?.answer;
              const value = !answer ? theme.fg("warning", "unanswered") : answer.skipped ? theme.fg("dim", "— skipped") : answer.wasCustom ? `${theme.fg("muted", "(wrote) ")}${answer.labels.join(", ")}` : answer.labels.join(", ");
              const prefix = reviewCursor === index ? theme.fg("accent", "> ") : "  ";
              addPrefixed(prefix, truncateToWidth(`${theme.fg("muted", `${q.label}: `)}${value}`, Math.max(1, w - 2), "…"));
            });
            lines.push("");
            const submitPrefix = reviewCursor === questions.length ? theme.fg("accent", "> ") : "  ";
            addPrefixed(submitPrefix, allRequiredAnswered() ? theme.fg("success", "Submit") : theme.fg("warning", "Resolve required questions"));
          } else {
            const q = currentQuestion();
            const state = currentState();
            if (q && state) {
              addPrefixed(" ", theme.fg("text", q.prompt));
              lines.push("");
              if (mode === "editing") {
                addPrefixed(" ", theme.fg("muted", q.freeTextPlaceholder || "Your answer:"));
                if (w <= 1) editor.render(1).forEach((line) => lines.push(truncateToWidth(line, w, "")));
                else editor.render(w - 1).forEach((line) => lines.push(truncateToWidth(` ${line}`, w, "")));
              } else {
                const options = optionsFor(q);
                const start = Math.max(0, Math.min(state.cursor - 8, Math.max(0, options.length - 10)));
                const visible = options.slice(start, start + 10);
                visible.forEach((option, offset) => {
                  const index = start + offset;
                  const selected = index === state.cursor;
                  const prefix = selected ? theme.fg("accent", "> ") : "  ";
                  const check = q.multiSelect && !option.isOther ? `[${state.checked.has(index) ? "x" : " "}] ` : "";
                  addPrefixed(prefix, theme.fg(selected ? "accent" : "text", `${check}${index + 1}. ${option.label}`));
                  if (option.description) addPrefixed("     ", theme.fg("muted", option.description));
                });
                if (options.length > 10) addPrefixed(" ", theme.fg("dim", `${start + 1}-${Math.min(start + 10, options.length)} of ${options.length}`));
                if (!q.required) addPrefixed(" ", theme.fg("dim", "Optional · s to skip"));
                if (state.error) addPrefixed(" ", theme.fg("warning", state.error));
              }
            }
          }

          lines.push("");
          const q = currentQuestion();
          const stepHelp = questions.length > 1 ? " • ←→ steps" : "";
          let help = mode === "editing" ? "Enter submit • Esc back" : step === questions.length ? "↑↓ choose • Enter edit/submit • Ctrl+Enter submit • ← back • Esc cancel" : q?.multiSelect ? `↑↓ move • Space toggle • Enter confirm${stepHelp} • Esc cancel` : `↑↓ move • Enter confirm${stepHelp} • Esc cancel`;
          if (visibleWidth(help) > w - 2) help = mode === "editing" ? "Enter • Esc" : "↑↓ • Enter • Esc";
          addPrefixed(" ", theme.fg("dim", help));
          lines.push(theme.fg("accent", "─".repeat(w)));
          cachedWidth = width;
          cachedLines = lines;
          return lines;
        };

        return {
          render,
          invalidate: () => { cachedWidth = undefined; cachedLines = undefined; },
          handleInput,
          get focused() { return editor.focused; },
          set focused(value: boolean) { editor.focused = value; },
        };
      });

      if (result.cancelled) return { content: [{ type: "text", text: "User cancelled the questions." }], details: result };
      const text = result.answers.map((answer) => {
        const label = questions.find((q) => q.id === answer.id)?.label || answer.id;
        if (answer.skipped) return `${label}: user skipped (optional)`;
        if (answer.wasCustom) return `${label}: user wrote: ${answer.labels[0]}`;
        return `${label}: user selected: ${answer.labels.join(", ")}`;
      }).join("\n");
      return { content: [{ type: "text", text }], details: result };
    },

    renderCall(args, theme) {
      const questions = Array.isArray(args.questions) ? args.questions : [];
      const labels = questions.map((q: { label?: string; id?: string }) => q.label || q.id).filter(Boolean).join(", ");
      return new Text(`${theme.fg("toolTitle", theme.bold("ask_user "))}${theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`)}${labels ? theme.fg("dim", ` (${labels})`) : ""}`, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as Result | undefined;
      if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
      if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      return new Text(details.answers.map((answer) => answer.skipped ? `${theme.fg("dim", "⊘")} ${answer.id}: skipped` : `${theme.fg("success", "✓")} ${theme.fg("accent", answer.id)}: ${answer.labels.join(", ")}`).join("\n"), 0, 0);
    },
  });
}
