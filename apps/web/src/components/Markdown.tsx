// `React` importado explicitamente (diferente do resto do app) porque o
// runtime de teste (`tsx --test`) usa o transform clássico de JSX, que
// exige o identificador no escopo — o build de produção via Vite usa o
// runtime automático e ignora este import.
import React, { Fragment, type ReactNode, useState } from 'react';

// Renderizador de markdown de chat, seguro contra XSS por construção: nunca
// usa dangerouslySetInnerHTML nem concatena string pra virar HTML — em vez
// disso monta uma árvore de elementos React a partir de tokens, então o
// escape automático do React cobre qualquer texto de usuário em qualquer
// posição, formatado ou não. Cobre negrito/itálico/negrito+itálico/
// sublinhado/tachado/spoiler/código inline/bloco de código/links — não
// cobre escape com barra invertida, citações nem listas (fica pra depois,
// ver DISCORD_PARITY_PLAN.md).

const URL_PATTERN = /(https?:\/\/[^\s<]+[^\s<.,;:!?'")\]])/;

interface InlineRule {
  pattern: RegExp;
  recurse: boolean;
  render: (key: string, inner: ReactNode) => ReactNode;
}

const INLINE_RULES: InlineRule[] = [
  { pattern: /```([\s\S]+?)```/, recurse: false, render: (key, inner) => (
    <pre key={key} className="md-code-block"><code>{inner}</code></pre>
  ) },
  { pattern: /`([^`]+?)`/, recurse: false, render: (key, inner) => (
    <code key={key} className="md-inline-code">{inner}</code>
  ) },
  { pattern: /\*\*\*([\s\S]+?)\*\*\*/, recurse: true, render: (key, inner) => (
    <strong key={key}><em>{inner}</em></strong>
  ) },
  { pattern: /\*\*([\s\S]+?)\*\*/, recurse: true, render: (key, inner) => <strong key={key}>{inner}</strong> },
  { pattern: /__([\s\S]+?)__/, recurse: true, render: (key, inner) => <u key={key}>{inner}</u> },
  { pattern: /~~([\s\S]+?)~~/, recurse: true, render: (key, inner) => <del key={key}>{inner}</del> },
  { pattern: /\|\|([\s\S]+?)\|\|/, recurse: true, render: (key, inner) => <Spoiler key={key}>{inner}</Spoiler> },
  { pattern: /\*([\s\S]+?)\*/, recurse: true, render: (key, inner) => <em key={key}>{inner}</em> },
  { pattern: /_([\s\S]+?)_/, recurse: true, render: (key, inner) => <em key={key}>{inner}</em> },
];

function Spoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      className={`md-spoiler ${revealed ? 'revealed' : ''}`}
      onClick={() => setRevealed(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setRevealed(true);
        }
      }}
    >
      {children}
    </span>
  );
}

interface Counter {
  value: number;
}

function nextKey(counter: Counter, prefix: string): string {
  counter.value += 1;
  return `${prefix}-${counter.value}`;
}

function renderPlainWithLinks(text: string, counter: Counter): ReactNode[] {
  const parts = text.split(URL_PATTERN);
  const nodes: ReactNode[] = [];
  parts.forEach((part, index) => {
    if (!part) return;
    if (index % 2 === 1) {
      nodes.push(
        <a key={nextKey(counter, 'link')} href={part} target="_blank" rel="noopener noreferrer">
          {part}
        </a>,
      );
    } else {
      nodes.push(part);
    }
  });
  return nodes;
}

function findEarliestMatch(text: string): { rule: InlineRule; match: RegExpExecArray } | null {
  let best: { rule: InlineRule; match: RegExpExecArray } | null = null;
  for (const rule of INLINE_RULES) {
    const match = new RegExp(rule.pattern.source).exec(text);
    if (!match) continue;
    if (!best || match.index < best.match.index) best = { rule, match };
  }
  return best;
}

// "before" (texto antes do match mais cedo encontrado) é garantidamente
// livre de qualquer outro match — se tivesse um, o índice dele seria menor,
// contradizendo "mais cedo" — então só precisa de auto-link, não recursão.
function renderInline(text: string, depth: number, counter: Counter): ReactNode[] {
  if (!text) return [];
  if (depth > 6) return renderPlainWithLinks(text, counter);
  const found = findEarliestMatch(text);
  if (!found) return renderPlainWithLinks(text, counter);

  const { rule, match } = found;
  const before = text.slice(0, match.index);
  const rest = text.slice(match.index + match[0].length);
  const innerRaw = match[1] ?? '';
  const key = nextKey(counter, 'md');
  const renderedInner = rule.recurse ? renderInline(innerRaw, depth + 1, counter) : innerRaw;

  const nodes: ReactNode[] = [];
  if (before) nodes.push(...renderPlainWithLinks(before, counter));
  nodes.push(rule.render(key, renderedInner));
  nodes.push(...renderInline(rest, depth, counter));
  return nodes;
}

export function MarkdownText({ text }: { text: string }) {
  const counter: Counter = { value: 0 };
  return <Fragment>{renderInline(text, 0, counter)}</Fragment>;
}
