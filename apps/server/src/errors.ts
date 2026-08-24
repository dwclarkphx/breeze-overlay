// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Error bodies that serve two callers at once — I18N.md §5.1.
 *
 * An endpoint like `/api/control/:id/:compId/update` is hit by the operator
 * panel *and* by a Companion button, a vMix script and someone's `curl`.
 * Localising the response body would put the second caller's logs into a
 * language the first caller's browser chose. So the body carries a
 * machine-readable code, an English message, and the parameters that built it;
 * a catalogue-carrying client localises from the code, and everything else
 * reads the same English it always did.
 *
 * The shape is additive on purpose. Every error body in this codebase is
 * `{ error: string, field? }` and both clients read `body.error` as a string,
 * so `code` and `params` arrive as siblings rather than nested under `error` —
 * nesting would break every existing caller in the name of not breaking
 * callers.
 *
 * **Not every error earns a code.** A 400 telling an integrator that `tags must
 * be an array` is a diagnostic: it is read in a terminal, by someone holding
 * the API docs, and giving it a code would imply a dialog somewhere renders it.
 * Codes are for refusals a person meets in the product.
 */

import { makeTranslator, type Params } from '@breeze/i18n';

import { serverI18n } from './i18n.js';

/**
 * The body every coded refusal returns.
 *
 * `error` keeps its type and its language. `code` is a frozen identifier — it
 * joins the frozen list in §2, so renaming one is a breaking change to any
 * integration matching on it, exactly like renaming a URL.
 */
export interface ErrorBody {
  /** English, always, in every deployment. */
  error: string;
  /** Frozen identifier, and the catalogue key a client formats from. */
  code: string;
  /** The values `error` was built from, for a client to format its own copy. */
  params?: Params;
  /** Existing field-level marker, where the refusal names one. */
  field?: string;
}

/**
 * The code *is* the catalogue key.
 *
 * The alternative — a short code plus a table mapping it to a key — is a second
 * thing to keep in sync, and a client would have to build the key at runtime,
 * which `i18n:check` refuses precisely because it cannot verify it. Making them
 * the same string means the server's literal is what the checker sees, and
 * `t(code)` on the client needs no lookup table at all.
 *
 * The `error.` prefix is the price, and it is worth paying: an integrator
 * matching `body.code === 'error.compositionInUse'` gets a string that is
 * obviously an identifier rather than something that might be prose.
 */
export function fail(code: string, params?: Params, field?: string): ErrorBody {
  const english = makeTranslator(serverI18n().source);
  return {
    error: english(code, params),
    code,
    ...(params ? { params } : {}),
    ...(field ? { field } : {}),
  };
}
