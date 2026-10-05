import React, { useEffect, useState } from 'react';
import { inlineRuns, mathParts, splitQuestion } from '../lib/notes';
import { SlideChip } from './Slides';

// KaTeX is fetched the first time a note has maths in it, never before: most
// notes have none, and it is the largest thing the notes views could load.
let katexLoading = null;
let katexReady = null;
const loadKatex = () => {
  if (!katexLoading) {
    katexLoading = Promise.all([import('katex'), import('katex/dist/katex.min.css')])
      .then(([module]) => {
        katexReady = module.default || module;
        return katexReady;
      })
      .catch((err) => {
        katexLoading = null; // a failed chunk download can be tried again
        throw err;
      });
  }
  return katexLoading;
};

const renderTex = (katex, tex, display) =>
  katex.renderToString(tex, {
    displayMode: display,
    // A formula the model got slightly wrong shows in red, not as an error.
    throwOnError: false,
    strict: 'ignore',
    output: 'html',
  });

/** One LaTeX formula. Shows its source until KaTeX has loaded. */
export const MathText = ({ tex, display = false }) => {
  const [html, setHtml] = useState(() => (katexReady ? renderTex(katexReady, tex, display) : null));

  useEffect(() => {
    let live = true;
    loadKatex()
      .then((katex) => live && setHtml(renderTex(katex, tex, display)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [tex, display]);

  if (html === null) {
    return <code className="font-mono text-[0.9em] text-violet-200/80">{tex}</code>;
  }
  return (
    <span
      className={display ? 'lumina-math-display' : 'lumina-math'}
      // KaTeX escapes the source, and without `trust` it allows no links or
      // HTML of its own; the markup is its rendering of the formula.
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

/** Text that may hold formulas, as inside a bold term: "**Rendement $\eta$**". */
const WithMath = ({ text }) =>
  mathParts(text).map((part) =>
    part.math ? (
      <MathText key={part.key} tex={part.tex} display={part.display} />
    ) : (
      <React.Fragment key={part.key}>{part.text}</React.Fragment>
    ),
  );

/**
 * One bullet's inline Markdown and LaTeX, rendered rather than shown as symbols.
 * `promote` sets a text that is a single formula at full size, as a
 * flashcard's answer should be, instead of squeezed into a line of text.
 */
export const InlineText = ({ text, promote = false }) =>
  inlineRuns(text).map((run, index, runs) =>
    run.math ? (
      <MathText key={run.key} tex={run.tex} display={run.display || (promote && runs.length === 1)} />
    ) : run.cite ? (
      <SlideChip key={run.key} page={run.page} last={run.last} />
    ) : run.bold ? (
      <strong key={run.key} className="font-semibold text-zinc-100">
        <WithMath text={run.text} />
      </strong>
    ) : run.code ? (
      <code
        key={run.key}
        className="px-1 py-0.5 rounded bg-white/5 text-violet-200 text-[0.85em] font-mono"
      >
        {run.text}
      </code>
    ) : run.italic ? (
      <em key={run.key}>
        <WithMath text={run.text} />
      </em>
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
