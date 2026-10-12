/**
 * API tokens: a new token is shown once, with the address to use it against,
 * and revoking takes a second click.
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiTokens } from './ApiTokens';
import { createApiToken, listApiTokens, revokeApiToken } from '../services/api';

jest.mock('../services/api', () => ({
  API_ROOT: 'https://lumina.example.com/api',
  errorMessage: (err, fallback) => fallback,
  listApiTokens: jest.fn(),
  createApiToken: jest.fn(),
  revokeApiToken: jest.fn(),
}));

const existing = {
  id: 't1', name: 'Laptop', prefix: 'lum_AbCdEf', created_at: '2026-10-01T10:00:00Z', last_used_at: null,
};

let container;
let root;

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  listApiTokens.mockResolvedValue([existing]);
  createApiToken.mockResolvedValue({
    id: 't2', name: 'Claude', prefix: 'lum_secret', created_at: '2026-10-12T10:00:00Z', token: 'lum_secret-value',
  });
  revokeApiToken.mockResolvedValue({ id: 't1' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.clearAllMocks();
});

// The dialog renders in a portal on <body>, outside the container.
const byId = (id) => document.querySelector(`[data-testid="${id}"]`);
const click = async (id) => {
  await act(async () => {
    byId(id).click();
  });
};

const render = async (open = true) => {
  await act(async () => root.render(<ApiTokens open={open} onOpenChange={() => {}} />));
};

it('lists the tokens already made, without their secrets', async () => {
  await render();
  expect(byId('token-list').textContent).toContain('Laptop');
  expect(byId('token-list').textContent).toContain('lum_AbCdEf…');
  expect(byId('token-list').textContent).toContain('never used');
});

it('shows a new token once, with the backend address', async () => {
  await render();
  await click('create-token-btn');
  expect(createApiToken).toHaveBeenCalledWith('Claude');
  expect(byId('new-token-value').textContent).toBe('lum_secret-value');
  expect(byId('api-url-value').textContent).toBe('https://lumina.example.com');

  // Closed and opened again, the token is gone for good.
  await render(false);
  await render(true);
  expect(byId('new-token')).toBeNull();
});

it('revokes only on the second click', async () => {
  await render();
  await click('revoke-token-t1');
  expect(revokeApiToken).not.toHaveBeenCalled();
  expect(byId('revoke-token-t1').textContent).toContain('Revoke?');

  await click('revoke-token-t1');
  expect(revokeApiToken).toHaveBeenCalledWith('t1');
  expect(byId('token-list')).toBeNull();
});
