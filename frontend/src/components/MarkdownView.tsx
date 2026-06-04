import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

interface Props {
  source: string;
  className?: string;
}

export function isMarkdownPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx');
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function splitFrontmatter(src: string): { frontmatter: string | null; body: string } {
  const m = src.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: null, body: src };
  return { frontmatter: m[1], body: src.slice(m[0].length) };
}

export function MarkdownView({ source, className }: Props) {
  const { frontmatter, body } = splitFrontmatter(source);

  return (
    <div className={`md-view ${className ?? ''}`}>
      {frontmatter !== null && (
        <details className="mb-4 rounded-md border border-slate-800 bg-slate-900/60 open:bg-slate-900/80" open>
          <summary className="cursor-pointer list-none px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 select-none hover:text-slate-200">
            Frontmatter
          </summary>
          <pre className="overflow-x-auto border-t border-slate-800 px-3 py-2 text-[12px] leading-relaxed text-slate-200">
            <code className="language-yaml font-mono">{frontmatter}</code>
          </pre>
        </details>
      )}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          h1: ({ node, ...p }) => (
            <h1
              {...p}
              className="mt-6 mb-3 border-b border-slate-800 pb-2 text-xl font-semibold text-slate-50"
            />
          ),
          h2: ({ node, ...p }) => (
            <h2
              {...p}
              className="mt-6 mb-2 border-b border-slate-800/70 pb-1 text-lg font-semibold text-slate-100"
            />
          ),
          h3: ({ node, ...p }) => (
            <h3 {...p} className="mt-5 mb-2 text-[15px] font-semibold text-slate-100" />
          ),
          h4: ({ node, ...p }) => (
            <h4 {...p} className="mt-4 mb-1 text-[13px] font-semibold uppercase tracking-wider text-slate-300" />
          ),
          p: ({ node, ...p }) => (
            <p {...p} className="my-2 text-[13px] leading-relaxed text-slate-300" />
          ),
          a: ({ node, ...p }) => (
            <a
              {...p}
              target="_blank"
              rel="noreferrer noopener"
              className="text-cyan-300 underline-offset-2 hover:underline"
            />
          ),
          ul: ({ node, ...p }) => (
            <ul {...p} className="my-2 list-disc space-y-1 pl-5 text-[13px] text-slate-300" />
          ),
          ol: ({ node, ...p }) => (
            <ol {...p} className="my-2 list-decimal space-y-1 pl-5 text-[13px] text-slate-300" />
          ),
          li: ({ node, ...p }) => <li {...p} className="leading-relaxed marker:text-slate-600" />,
          blockquote: ({ node, ...p }) => (
            <blockquote
              {...p}
              className="my-3 border-l-2 border-cyan-700/60 bg-slate-900/60 px-3 py-1 text-[13px] italic text-slate-300"
            />
          ),
          hr: ({ node, ...p }) => <hr {...p} className="my-5 border-slate-800" />,
          table: ({ node, ...p }) => (
            <div className="my-3 overflow-x-auto rounded-md border border-slate-800">
              <table {...p} className="w-full text-[12px]" />
            </div>
          ),
          thead: ({ node, ...p }) => <thead {...p} className="bg-slate-900/80" />,
          th: ({ node, ...p }) => (
            <th
              {...p}
              className="border-b border-slate-800 px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400"
            />
          ),
          td: ({ node, ...p }) => (
            <td {...p} className="border-b border-slate-800/60 px-3 py-2 align-top text-slate-300" />
          ),
          code: ({ node, inline, className, children, ...p }: any) =>
            inline ? (
              <code
                {...p}
                className="rounded bg-slate-800/80 px-1 py-0.5 font-mono text-[11.5px] text-amber-200"
              >
                {children}
              </code>
            ) : (
              <code {...p} className={`${className ?? ''} font-mono text-[12px] leading-relaxed`}>
                {children}
              </code>
            ),
          pre: ({ node, ...p }) => (
            <pre
              {...p}
              className="my-3 overflow-x-auto rounded-md border border-slate-800 bg-slate-950 p-3 text-[12px] leading-relaxed text-slate-200"
            />
          ),
          img: ({ node, ...p }) => (
            <img {...p} className="my-3 max-w-full rounded-md border border-slate-800" />
          ),
          input: ({ node, ...p }: any) =>
            p.type === 'checkbox' ? (
              <input
                {...p}
                disabled
                className="mr-1 align-middle accent-cyan-500"
              />
            ) : (
              <input {...p} />
            ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
