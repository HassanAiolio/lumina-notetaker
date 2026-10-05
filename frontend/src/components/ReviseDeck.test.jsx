/**
 * The revision deck: a card is answered from memory, then checked, and one
 * that was missed comes back until it is got right.
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ReviseDeck } from './ReviseDeck';

// jsdom never finishes an exit animation, so AnimatePresence would hold the
// next card back forever. Plain elements keep the test about the deck itself.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  const strip = ({ initial, animate, exit, transition, ...rest }) => rest;
  const motion = new Proxy({}, {
    get: (_, tag) => ReactActual.forwardRef((props, ref) => ReactActual.createElement(tag, { ...strip(props), ref })),
  });
  return { motion, AnimatePresence: ({ children }) => children };
});

const note = {
  sections: {
    review_questions: ['Que mesure l’entropie ? → Le désordre', 'Que vaut η à 600/300 K ? → 50 %'],
    definitions: ['**Entropie** : fonction d’état S'],
  },
};

let container;
let root;

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const byId = (id) => container.querySelector(`[data-testid="${id}"]`);
const click = async (id) => {
  await act(async () => {
    byId(id).click();
  });
};

it('hides the answer until asked, then grades the card', async () => {
  await act(async () => root.render(<ReviseDeck note={note} />));
  expect(container.textContent).toContain('Que mesure l’entropie ?');
  expect(container.textContent).not.toContain('Le désordre');

  await click('deck-reveal');
  expect(container.textContent).toContain('Le désordre');
  await click('deck-knew');
  expect(container.textContent).toContain('1 / 3 done');
});

it('brings a missed card back at the end, and counts it as missed', async () => {
  await act(async () => root.render(<ReviseDeck note={note} />));
  await click('deck-reveal');
  await click('deck-again'); // first question missed
  expect(container.textContent).toContain('1 to retry');

  // The other two, then the missed one again.
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await click('deck-reveal');
    // eslint-disable-next-line no-await-in-loop
    await click('deck-knew');
  }
  expect(byId('deck-done')).not.toBeNull();
  expect(container.textContent).toContain('2 of 3 right first time');
});

it('says so when a note has nothing to revise from', async () => {
  await act(async () => root.render(<ReviseDeck note={{ sections: { overview: ['Rien à réviser'] } }} />));
  expect(byId('deck-empty')).not.toBeNull();
});
