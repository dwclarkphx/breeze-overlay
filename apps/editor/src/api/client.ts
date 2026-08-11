// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * REST client for the Breeze server.
 *
 * Validation failures come back as 422 with a JSON-pointer issue list; those
 * are surfaced as structured errors rather than a generic "save failed", so the
 * editor can point at the offending layer instead of making the user guess.
 */

import type {
  AssetEdit,
  AssetRef,
  AssetUsage,
  Composition,
  DataColumn,
  DataSet,
  DataSourceDef,
  DataSourceStatus,
  DataTransform,
  Project,
} from '@breeze/schema';

export interface ValidationIssue {
  path: string;
  message: string;
}

/** One composition that mounts another as a layer — why a delete was refused. */
export interface CompositionReferrer {
  id: string;
  name: string;
  layer: string;
  independent: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly issues: ValidationIssue[];
  /**
   * The whole parsed error body.
   *
   * Some refusals carry structure beyond a message — a 409 on a scene delete
   * names the compositions still mounting it — and a caller that wants to put
   * that list in front of the user needs it without a second round trip.
   */
  readonly body: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    issues: ValidationIssue[] = [],
    body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.issues = issues;
    this.body = body;
  }

  get isValidation(): boolean {
    return this.status === 422;
  }

  /** Compositions still mounting the one this delete was refused for. */
  get referrers(): CompositionReferrer[] {
    return Array.isArray(this.body.referrers) ? (this.body.referrers as CompositionReferrer[]) : [];
  }
}

export interface MediaCapabilities {
  /** True only when ffmpeg is present *and* can encode VP9 with alpha. */
  available: boolean;
  version: string | null;
  vp9Alpha: boolean;
  /** Why not, in words to put in front of an operator. */
  reason: string | null;
}

export interface MediaInfo {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  pixelFormat: string | null;
  hasAlpha: boolean;
  frameRate: number | null;
}

export interface TranscodeJob {
  id: string;
  projectId: string;
  sourceAssetId: string;
  sourceName: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  /** 0..1, or null when the source duration could not be read. */
  progress: number | null;
  outputAsset?: { id: string; path: string; originalName?: string };
  error?: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * What an upload returns.
 *
 * The three fields past `asset` are only ever non-empty for a Replace, and the
 * caller needs all of them: `replaced` to drop the superseded row from any open
 * picker, `rewritten` to tell the operator how many graphics just changed
 * underneath them, and `compositions` to name them. A replace that silently
 * edited four other compositions would be the kind of help nobody asked for.
 */
export interface UploadResult {
  asset: AssetRef;
  /** The superseded asset, now retired. Null for an ordinary upload. */
  replaced: AssetRef | null;
  /** How many `src` references the server repointed. */
  rewritten: number;
  compositions: Array<{ id: string; name: string }>;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  compositions: Array<{ id: string; name: string }>;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  /*
   * `content-type` is set only when there is a body to describe.
   *
   * Declaring `application/json` on a bodyless `DELETE` is a lie the server is
   * entitled to believe, and Fastify does: it looks for the JSON the header
   * promised, finds nothing, and answers `Body cannot be empty when
   * content-type is set to 'application/json'`. Every `DELETE` this helper
   * sends — project, composition, asset, data source, transcode job — went out
   * that way, so all five were broken in the browser.
   *
   * They passed their tests because `app.inject` sets no content-type unless a
   * payload is given, so the suite exercised a request the editor never
   * actually makes. Testing through the same helper the editor uses is the fix
   * for *that*, and is what `client.test.ts` now does.
   */
  const hasBody = init?.body !== undefined && init?.body !== null;

  const response = await fetch(url, {
    ...init,
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let body: { error?: string; issues?: ValidationIssue[] } & Record<string, unknown> = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // Non-JSON error body (proxy error page, connection reset) — the status
      // line is all we have.
    }
    throw new ApiError(
      body.error ?? response.statusText,
      response.status,
      body.issues ?? [],
      body,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  listProjects: () =>
    request<{ projects: ProjectSummary[] }>('/api/projects').then((r) => r.projects),

  getProject: (id: string) => request<Project>(`/api/projects/${encodeURIComponent(id)}`),

  /**
   * `key` is the chosen half of the project's URL key — `rahb` becomes
   * `rahb-1k3f9`. Omitted, the server generates `proj-…` as it always did.
   * Set once at creation: it is the id, and the id is in every browser-source
   * URL already pasted into OBS.
   */
  createProject: (name: string, key?: string) =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(key ? { name, key } : { name }),
    }),

  saveProject: (project: Project) =>
    request<Project>(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: 'PUT',
      body: JSON.stringify(project),
    }),

  /**
   * Delete a project — its compositions, assets and data sources, from disk.
   *
   * There is no undo behind this and no trash to restore from; the server does
   * a recursive remove. Every caller is expected to have made the user type the
   * project's name first.
   */
  deleteProject: (id: string) =>
    request<void>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * Ask the server what a name suggests as a URL key, under the same rules it
   * enforces on creation — so the field cannot propose something the POST will
   * then reject.
   */
  suggestKey: (name: string) =>
    request<{ key: string; valid: boolean; maxLength: number }>(
      `/api/keys/suggest?name=${encodeURIComponent(name)}`,
    ),

  saveComposition: (projectId: string, comp: Composition) =>
    request<Project>(
      `/api/projects/${encodeURIComponent(projectId)}/compositions/${encodeURIComponent(comp.id)}`,
      { method: 'PUT', body: JSON.stringify(comp) },
    ),

  /**
   * Create a scene.
   *
   * `key` is the chosen half of its URL key, exactly as for a project. The
   * server checks it against every channel the project already answers to, not
   * just its composition ids — see the route.
   */
  createComposition: (projectId: string, name: string, key?: string) =>
    request<Composition>(`/api/projects/${encodeURIComponent(projectId)}/compositions`, {
      method: 'POST',
      body: JSON.stringify(key ? { name, key } : { name }),
    }),

  /**
   * Compositions that mount this one as a layer.
   *
   * Asked *before* offering the delete, so the menu item can be disabled with a
   * reason rather than accepted and then refused — the server returns the same
   * list on a 409, but finding out after the confirmation dialog is a worse
   * place to learn it.
   */
  compositionReferrers: (projectId: string, compId: string) =>
    request<{ referrers: CompositionReferrer[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/compositions/${encodeURIComponent(compId)}/referrers`,
    ).then((r) => r.referrers),

  /** Refused with 409 while anything still mounts it — see `compositionReferrers`. */
  deleteComposition: (projectId: string, compId: string) =>
    request<Project>(
      `/api/projects/${encodeURIComponent(projectId)}/compositions/${encodeURIComponent(compId)}`,
      { method: 'DELETE' },
    ),

  /**
   * Validate without saving. The editor calls this as the document changes so
   * problems surface while the user is still looking at the layer that caused
   * them, rather than at save time.
   */
  validateComposition: (comp: Composition) =>
    request<{ valid: boolean; errors: ValidationIssue[] }>('/api/validate/composition', {
      method: 'POST',
      body: JSON.stringify(comp),
    }),

  /* --------------------------------------------------------------- assets */

  listAssets: (projectId: string) =>
    request<{ assets: AssetRef[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/assets`,
    ).then((r) => r.assets),

  /**
   * Upload one file.
   *
   * `XMLHttpRequest` rather than `fetch`, for the one thing it still does that
   * `fetch` does not: report upload progress. A ProRes stinger is hundreds of
   * megabytes and takes minutes over a venue LAN, and an upload with no
   * progress is one the operator assumes has hung and cancels — usually
   * repeatedly, which is worse than waiting.
   *
   * The body is the file itself, raw. The server takes no multipart, so there
   * is no FormData here and no boundary for either side to get wrong.
   */
  uploadAsset: (
    projectId: string,
    file: File,
    onProgress?: (fraction: number) => void,
    /**
     * Asset id this upload supersedes, when the operator chose Replace.
     *
     * Sent with the bytes rather than negotiated first: the server cannot
     * detect the collision until the file has arrived, so a 409-then-retry
     * would mean uploading a stinger twice to answer one question.
     */
    replaces?: string,
  ): Promise<UploadResult> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/assets?name=${encodeURIComponent(file.name)}` +
          (replaces ? `&replaces=${encodeURIComponent(replaces)}` : ''),
      );
      // Whatever the browser guessed from the extension is not to be trusted
      // and is not used; the server classifies from the name it was given.
      xhr.setRequestHeader('content-type', 'application/octet-stream');

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      });

      xhr.addEventListener('load', () => {
        let body: Partial<UploadResult> & { error?: string } = {};
        try {
          body = JSON.parse(xhr.responseText) as typeof body;
        } catch {
          /* Non-JSON error body — the status line is all there is. */
        }
        if (xhr.status >= 200 && xhr.status < 300 && body.asset) {
          resolve({
            asset: body.asset,
            replaced: body.replaced ?? null,
            rewritten: body.rewritten ?? 0,
            compositions: body.compositions ?? [],
          });
        } else reject(new ApiError(body.error ?? xhr.statusText, xhr.status));
      });

      xhr.addEventListener('error', () =>
        reject(new ApiError('upload failed — the server could not be reached', 0)),
      );
      xhr.addEventListener('abort', () => reject(new ApiError('upload cancelled', 0)));

      xhr.send(file);
    }),

  deleteAsset: (projectId: string, assetId: string) =>
    request<void>(
      `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`,
      { method: 'DELETE' },
    ),

  /** Edit one asset's descriptive, administrative or rights fields. */
  updateAsset: (projectId: string, assetId: string, edit: AssetEdit) =>
    request<{ asset: AssetRef }>(
      `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`,
      { method: 'PATCH', body: JSON.stringify(edit) },
    ).then((r) => r.asset),

  /**
   * Apply one edit to many assets, in one request.
   *
   * Not a loop over `updateAsset`: each of those takes the server's index lock
   * in turn, so filing forty files would be forty round trips an operator
   * watches tick past before a show.
   */
  updateAssets: (projectId: string, ids: string[], edit: AssetEdit, addTags: string[] = []) =>
    request<{ assets: AssetRef[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/assets`,
      { method: 'PATCH', body: JSON.stringify({ ids, edit, addTags }) },
    ).then((r) => r.assets),

  /** The project's tag vocabulary — outlives the assets that used each term. */
  listAssetTags: (projectId: string) =>
    request<{ tags: string[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/assets/tags`,
    ).then((r) => r.tags),

  /**
   * Where an asset is used, across every composition in the project.
   *
   * The answer the bin could never give on its own: `referencedAssets` in the
   * editor only ever saw the composition currently open, so "in use" meant "in
   * use here" and delete was a guess about everything else.
   */
  assetUsage: (projectId: string, assetId: string) =>
    request<{ usage: AssetUsage[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/usage`,
    ).then((r) => r.usage),

  /* ------------------------------------------------------------ transcode */

  /** Whether this server can transcode, and the reason when it cannot. */
  mediaCapabilities: () =>
    request<MediaCapabilities>('/api/media/capabilities'),

  probeAsset: (projectId: string, assetId: string) =>
    request<{ info: MediaInfo }>(
      `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/probe`,
    ).then((r) => r.info),

  transcodeAsset: (projectId: string, assetId: string) =>
    request<{ job: TranscodeJob }>(
      `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/transcode`,
      { method: 'POST' },
    ).then((r) => r.job),

  listTranscodes: (projectId: string) =>
    request<{ jobs: TranscodeJob[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/transcodes`,
    ).then((r) => r.jobs),

  cancelTranscode: (projectId: string, jobId: string) =>
    request<void>(
      `/api/projects/${encodeURIComponent(projectId)}/transcodes/${encodeURIComponent(jobId)}`,
      { method: 'DELETE' },
    ),

  bindings: (projectId: string, compId: string) =>
    request<{
      bindings: Array<{ name: string; kind: string; layerIds: string[]; defaultValue: unknown; label: string }>;
      schema: Record<string, unknown>;
      stepCount: number;
    }>(
      `/api/projects/${encodeURIComponent(projectId)}/compositions/${encodeURIComponent(compId)}/bindings`,
    ),

  /* -------------------------------------------------------- data sources */

  /**
   * `rows` asks for each source's rows alongside its definition — what the
   * stage preview needs to render a source-fed layer with real data. Omit it
   * for the data panel's health poll, which only reads counts and timestamps.
   */
  listDataSources: (projectId: string, rows?: number) =>
    request<{ sources: DataSourceSummary[]; minPollInterval: number }>(
      `/api/projects/${encodeURIComponent(projectId)}/datasources${rows ? `?rows=${rows}` : ''}`,
    ),

  getDataSource: (projectId: string, sourceId: string, rows = 200) =>
    request<{
      def: DataSourceDef;
      interval: number;
      status: DataSourceStatus;
      data: DataSet;
      truncated: boolean;
    }>(
      `/api/projects/${encodeURIComponent(projectId)}/datasources/${encodeURIComponent(sourceId)}?rows=${rows}`,
    ),

  saveDataSource: (projectId: string, def: DataSourceDef) =>
    request<{ def: DataSourceDef; status: DataSourceStatus; interval: number }>(
      `/api/projects/${encodeURIComponent(projectId)}/datasources/${encodeURIComponent(def.id)}`,
      { method: 'PUT', body: JSON.stringify(def) },
    ),

  deleteDataSource: (projectId: string, sourceId: string) =>
    request<void>(
      `/api/projects/${encodeURIComponent(projectId)}/datasources/${encodeURIComponent(sourceId)}`,
      { method: 'DELETE' },
    ),

  refreshDataSource: (projectId: string, sourceId: string) =>
    request<{ status: DataSourceStatus; data: DataSet }>(
      `/api/projects/${encodeURIComponent(projectId)}/datasources/${encodeURIComponent(sourceId)}/refresh`,
      { method: 'POST' },
    ),

  /**
   * Try a source without saving it. Returns `ok: false` with a message rather
   * than throwing — a URL that is wrong while it is being typed is the normal
   * case, not an exception.
   */
  previewDataSource: (projectId: string, def: DataSourceDef, transforms?: DataTransform[]) =>
    request<{ ok: boolean; error?: string; data?: DataSet; rowCount?: number; truncated?: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/datasources-preview`,
      { method: 'POST', body: JSON.stringify({ def, transforms }) },
    ),

  inspectJsonFeed: (projectId: string, url: string) =>
    request<{ ok: boolean; error?: string; rowPath?: string; sample?: unknown }>(
      `/api/projects/${encodeURIComponent(projectId)}/datasources-inspect`,
      { method: 'POST', body: JSON.stringify({ url }) },
    ),

  /**
   * The XML sibling. Returns candidate paths with counts rather than one guess,
   * because in an unfamiliar export several elements repeat and only the author
   * knows which one is a row.
   */
  inspectXmlFeed: (projectId: string, url: string) =>
    request<{
      ok: boolean;
      error?: string;
      rowPath?: string;
      feed?: 'rss' | 'rdf' | 'atom' | null;
      candidates?: Array<{ path: string; count: number }>;
      title?: string;
    }>(`/api/projects/${encodeURIComponent(projectId)}/datasources-inspect-xml`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
};

export interface DataSourceSummary {
  def: DataSourceDef;
  interval: number;
  status: DataSourceStatus;
  columns: DataColumn[];
  rowCount: number;
  /** Present only when the request asked for rows. May be capped — see `truncated`. */
  data?: DataSet;
  truncated?: boolean;
}

/** URL of the transparent output page for a composition. */
export function playUrl(projectId: string, compId: string): string {
  return `/play/${encodeURIComponent(projectId)}/${encodeURIComponent(compId)}`;
}
