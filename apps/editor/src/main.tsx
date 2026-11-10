// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { I18nProvider } from '@breeze/i18n/react';
import { StrictMode, useEffect, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { SourcesPage } from './components/SourcesPage.js';
import { applyDocumentLocale, bootCatalogue, loadCatalogue } from './state/i18n.js';
import { isSourcesPage } from './state/sources-page.js';
import './styles.css';

/**
 * Mount in English, swap when the server says otherwise.
 *
 * The alternative — await the catalogue before the first render — buys a
 * flicker-free boot at the cost of a blank page on any slow or failed status
 * call, on a tool an operator opens minutes before a show. The editor already
 * renders placeholder panels until the project loads, so in practice the
 * catalogue lands before there is any text on screen to change.
 */
/*
 * One bundle, two pages (0.80.0): the editor, and the Data sources page the
 * portal links to — see `state/sources-page.ts` for why it lives here. Decided
 * once, at load: the two share no state and nothing navigates between them
 * without a page load. The attribute is what lets the stylesheet give the page
 * a scrolling document where the editor has a fixed, full-height frame.
 */
const SOURCES_PAGE = isSourcesPage();
if (SOURCES_PAGE) document.documentElement.dataset.view = 'sources';

function Root(): JSX.Element {
  const [catalogue, setCatalogue] = useState(bootCatalogue);

  useEffect(() => {
    let live = true;
    void loadCatalogue().then((next) => {
      if (!live) return;
      setCatalogue(next);
      applyDocumentLocale(next);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <I18nProvider catalogue={catalogue}>
      {SOURCES_PAGE ? <SourcesPage /> : <App />}
    </I18nProvider>
  );
}

const root = document.getElementById('root');
// Thrown before React mounts, so there is no catalogue and no UI to show it in; this
// reaches a developer through the console, never an operator.
// i18n-ignore-next-line
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
