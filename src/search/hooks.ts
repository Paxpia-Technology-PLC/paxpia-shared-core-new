// SEARCH HOOK — the headless React binding for the unified search bar. Owns the
// debounced query → suggestions + grouped results lifecycle over a `SearchApi`
// (+ optional local DM sources). React-only, so web + mobile share it; the shared
// @paxpia/ui SearchBar / SearchResults are pure props-driven views over this.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { timers } from '../messaging/timers';
import type { Message, Thread } from '../messaging/types';
import type { SearchApi } from './client';
import { unifiedSearch } from './client';
import { emptySearchResults, type SearchResults } from './types';

export interface UseSearchArgs {
  api: SearchApi;
  /** Scope: accounts only / content only / both (default 'all'). */
  kind?: 'account' | 'content' | 'all';
  /** Local DM sources to also scan (omit to skip DM search). */
  dmSources?: { threads: Thread[]; messagesByThread: Record<string, Message[]>; selfId?: string };
  /** Debounce before firing a search / suggest (ms; default 250). */
  debounceMs?: number;
  /** Minimum query length before hitting the network (default 1). */
  minChars?: number;
}

export interface SearchSession {
  query: string;
  setQuery: (q: string) => void;
  results: SearchResults;
  suggestions: string[];
  loading: boolean;
  /** Force a search NOW (e.g. on Enter / suggestion tap), bypassing the debounce. */
  submit: (q?: string) => void;
  clear: () => void;
}

/**
 * useSearch — debounced unified search. Typing updates `query` immediately; after
 * `debounceMs` of quiet it fetches suggestions + grouped results (accounts +
 * content from the backend, DMs from local state). `submit` fires immediately.
 */
export function useSearch({ api, kind = 'all', dmSources, debounceMs = 250, minChars = 1 }: UseSearchArgs): SearchSession {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults>(emptySearchResults);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  const run = useCallback(
    async (q: string) => {
      const id = ++reqId.current;
      const trimmed = q.trim();
      if (trimmed.length < minChars) {
        setResults(dmSources ? { accounts: [], content: [], dms: [] } : emptySearchResults());
        setSuggestions([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      const [res, sug] = await Promise.all([
        unifiedSearch(api, trimmed, { kind, dmSources }),
        api.suggest(trimmed).catch(() => [] as string[]),
      ]);
      // Drop stale responses (a newer query superseded this one).
      if (id !== reqId.current) return;
      setResults(res);
      setSuggestions(sug);
      setLoading(false);
    },
    [api, kind, dmSources, minChars],
  );

  // Debounced auto-run on query change.
  useEffect(() => {
    const t = timers.setTimeout(() => void run(query), debounceMs);
    return () => timers.clearTimeout(t);
  }, [query, debounceMs, run]);

  const submit = useCallback((q?: string) => {
    const next = q ?? query;
    if (q !== undefined) setQuery(q);
    void run(next);
  }, [query, run]);

  const clear = useCallback(() => {
    setQuery('');
    setResults(emptySearchResults());
    setSuggestions([]);
  }, []);

  return useMemo(
    () => ({ query, setQuery, results, suggestions, loading, submit, clear }),
    [query, results, suggestions, loading, submit, clear],
  );
}
