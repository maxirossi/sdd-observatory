import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { api, type FileContentRead } from '../lib/api';
import { MarkdownView, isMarkdownPath } from './MarkdownView';

interface Props {
  projectId: string;
  path: string;
  onClose: () => void;
}

// CSS Custom Highlight API — tipos no siempre presentes en lib.dom.
const cssHighlights: Map<string, unknown> | null =
  typeof CSS !== 'undefined' && 'highlights' in CSS ? (CSS as any).highlights : null;
const HighlightCtor: any = typeof window !== 'undefined' ? (window as any).Highlight : undefined;
const supportsHighlight = !!cssHighlights && !!HighlightCtor;

function collectRanges(root: HTMLElement, q: string): Range[] {
  const ranges: Range[] = [];
  if (!q) return ranges;
  const ql = q.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const text = node.nodeValue ?? '';
    const lower = text.toLowerCase();
    let idx = lower.indexOf(ql);
    while (idx !== -1) {
      try {
        const r = document.createRange();
        r.setStart(node, idx);
        r.setEnd(node, idx + q.length);
        ranges.push(r);
      } catch {
        /* nodo cambió bajo nuestros pies — ignorar */
      }
      idx = lower.indexOf(ql, idx + q.length);
    }
    node = walker.nextNode();
  }
  return ranges;
}

export function RawFileModal({ projectId, path, onClose }: Props) {
  const [content, setContent] = useState<FileContentRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'rendered' | 'raw'>('rendered');
  const isMd = isMarkdownPath(path);

  // Búsqueda
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [activeIdx, setActiveIdx] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setContent(null);
    setError(null);
    let cancelled = false;
    api
      .fileContent(projectId, path)
      .then((c) => !cancelled && setContent(c))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);

  // (Re)calcular matches cuando cambia query/contenido/modo.
  useEffect(() => {
    if (!supportsHighlight) return;
    cssHighlights!.delete('file-search');
    cssHighlights!.delete('file-search-active');
    rangesRef.current = [];
    const root = contentRef.current;
    if (!root || !query || !content) {
      setMatchCount(0);
      return;
    }
    // pequeño defer para que MarkdownView termine de pintar
    const id = window.setTimeout(() => {
      const ranges = collectRanges(root, query);
      rangesRef.current = ranges;
      setMatchCount(ranges.length);
      setActiveIdx(0);
      if (ranges.length) {
        cssHighlights!.set('file-search', new HighlightCtor(...ranges));
      }
    }, 30);
    return () => window.clearTimeout(id);
  }, [query, content, mode]);

  // Match activo + scroll.
  useEffect(() => {
    if (!supportsHighlight) return;
    cssHighlights!.delete('file-search-active');
    const ranges = rangesRef.current;
    const root = contentRef.current;
    if (!ranges.length || !root) return;
    const r = ranges[Math.min(activeIdx, ranges.length - 1)];
    if (!r) return;
    cssHighlights!.set('file-search-active', new HighlightCtor(r));
    const rect = r.getBoundingClientRect();
    const cr = root.getBoundingClientRect();
    if (rect.top < cr.top + 40 || rect.bottom > cr.bottom - 40) {
      root.scrollTop += rect.top - cr.top - cr.height / 2;
    }
  }, [activeIdx, matchCount]);

  // Limpieza al desmontar.
  useEffect(() => {
    return () => {
      if (supportsHighlight) {
        cssHighlights!.delete('file-search');
        cssHighlights!.delete('file-search-active');
      }
    };
  }, []);

  const go = (delta: number) => {
    if (matchCount === 0) return;
    setActiveIdx((i) => (i + delta + matchCount) % matchCount);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (e.key === 'Escape') {
        if (query) setQuery('');
        else onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, query]);

  const copy = async () => {
    if (content) await navigator.clipboard.writeText(content.content);
  };

  const matchLabel = useMemo(() => {
    if (!query) return '';
    if (matchCount === 0) return 'Sin coincidencias';
    return `${activeIdx + 1} de ${matchCount}`;
  }, [query, matchCount, activeIdx]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-mono text-[11px] text-slate-400">{path}</p>
            {content && (
              <p className="mt-0.5 text-[11px] text-slate-500">
                {content.size_bytes.toLocaleString()} bytes
                {content.truncated && <span className="ml-2 text-amber-400">· truncado</span>}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Buscador estilo VS Code */}
            <div className="flex items-center gap-1 rounded-md border border-slate-700 bg-slate-950/60 pl-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-slate-500" />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    go(e.shiftKey ? -1 : 1);
                  }
                }}
                placeholder="Buscar (Ctrl+F)"
                className="w-44 bg-transparent py-1 text-[12px] text-slate-100 placeholder:text-slate-600 focus:outline-none"
              />
              {query && (
                <span className="shrink-0 px-1 font-mono text-[10px] text-slate-500">{matchLabel}</span>
              )}
              <button
                type="button"
                onClick={() => go(-1)}
                disabled={matchCount === 0}
                title="Anterior (Shift+Enter)"
                className="p-1 text-slate-400 hover:text-slate-100 disabled:opacity-30"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => go(1)}
                disabled={matchCount === 0}
                title="Siguiente (Enter)"
                className="p-1 text-slate-400 hover:text-slate-100 disabled:opacity-30"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  title="Limpiar (Esc)"
                  className="p-1 text-slate-400 hover:text-slate-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {isMd && (
              <div className="flex rounded-md border border-slate-700 text-[11px]">
                <button
                  type="button"
                  onClick={() => setMode('rendered')}
                  className={`px-2 py-1 ${mode === 'rendered' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:bg-slate-800/60'}`}
                >
                  Vista
                </button>
                <button
                  type="button"
                  onClick={() => setMode('raw')}
                  className={`border-l border-slate-700 px-2 py-1 ${mode === 'raw' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:bg-slate-800/60'}`}
                >
                  Crudo
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={copy}
              disabled={!content}
              className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              Copiar
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
            >
              Cerrar (Esc)
            </button>
          </div>
        </header>

        <div ref={contentRef} className="flex-1 overflow-y-auto">
          {error && <p className="px-4 py-6 text-xs text-rose-300">{error}</p>}
          {!error && content == null && <Loading />}
          {!error &&
            content != null &&
            (isMd && mode === 'rendered' ? (
              <div className="mx-auto max-w-3xl px-6 py-5">
                <MarkdownView source={content.content} />
              </div>
            ) : (
              <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-relaxed text-slate-200">
                {content.content}
              </pre>
            ))}
        </div>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-2 p-4">
      <div className="h-4 w-2/3 animate-pulse rounded bg-slate-800" />
      <div className="h-4 w-3/4 animate-pulse rounded bg-slate-800" />
      <div className="h-4 w-1/2 animate-pulse rounded bg-slate-800" />
    </div>
  );
}
