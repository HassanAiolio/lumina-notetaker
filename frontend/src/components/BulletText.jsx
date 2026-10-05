import React, { useState } from 'react';
import { inlineRuns, splitQuestion } from '../lib/notes';

/** One bullet's inline Markdown, rendered rather than shown as asterisks. */
export const InlineText = ({ text }) =>
  inlineRuns(text).map((run) =>
    run.bold ? (
      <strong key={run.key} className="font-semibold text-zinc-100">
        {run.text}
      </strong>
    ) : run.code ? (
      <code
        key={run.key}
        className="px-1 py-0.5 rounded bg-white/5 text-violet-200 text-[0.85em] font-mono"
      >
        {run.text}
      </code>
    ) : run.italic ? (
      <em key={run.key}>{run.text}</em>
    ) : (
      <React.Fragment key={run.key}>{run.text}</React.Fragment>
    ),
  );

/**
 * A review question with its answer hidden until asked for.
 *
 * Reading a question with the answer beside it is re-reading, which is the
 * weakest way to revise; having to recall it first is what makes it stick.
 */
const Question = ({ question, answer }) => {
  const [revealed, setRevealed] = useState(false);
  return (
    <span className="block">
      <span className="text-zinc-200">
        <InlineText text={question} />
      </span>{' '}
      <button
        type="button"
        onClick={() => setRevealed((value) => !value)}
        aria-expanded={revealed}
        className={`mt-1 block text-left rounded-md px-2 py-1 transition-colors duration-200 ${
          revealed
            ? 'bg-violet-500/10 text-zinc-300'
            : 'bg-white/5 text-zinc-400 hover:text-white'
        }`}
        data-testid="reveal-answer"
      >
        {revealed ? <InlineText text={answer} /> : 'Show answer'}
      </button>
    </span>
  );
};

/** A bullet as its section wants it shown. */
export const BulletText = ({ sectionKey, text }) => {
  const pair = sectionKey === 'review_questions' ? splitQuestion(text) : null;
  return pair ? <Question {...pair} /> : <InlineText text={text} />;
};
