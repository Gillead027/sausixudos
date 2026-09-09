import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownText } from './Markdown.js';

function render(text: string): string {
  return renderToStaticMarkup(<MarkdownText text={text} />);
}

describe('MarkdownText', () => {
  it('renderiza texto simples sem marcação', () => {
    assert.equal(render('mensagem comum'), 'mensagem comum');
  });

  it('nunca interpreta HTML de usuário como marcação — sempre escapado', () => {
    const html = render('<script>alert(1)</script>');
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('escapa HTML mesmo dentro de negrito/itálico/spoiler', () => {
    assert.ok(!render('**<img src=x onerror=alert(1)>**').includes('<img'));
    assert.ok(!render('||<b>x</b>||').includes('<b>x</b>'));
  });

  it('negrito', () => {
    assert.equal(render('isso é **negrito** aqui'), 'isso é <strong>negrito</strong> aqui');
  });

  it('itálico com asterisco e com underscore', () => {
    assert.equal(render('*itálico*'), '<em>itálico</em>');
    assert.equal(render('_itálico_'), '<em>itálico</em>');
  });

  it('negrito e itálico combinados', () => {
    assert.equal(render('***tudo***'), '<strong><em>tudo</em></strong>');
  });

  it('sublinhado', () => {
    assert.equal(render('__sublinhado__'), '<u>sublinhado</u>');
  });

  it('tachado', () => {
    assert.equal(render('~~tachado~~'), '<del>tachado</del>');
  });

  it('código inline não processa marcação interna', () => {
    assert.equal(render('`**não vira negrito**`'), '<code class="md-inline-code">**não vira negrito**</code>');
  });

  it('bloco de código de múltiplas linhas', () => {
    assert.equal(
      render('```linha 1\nlinha 2```'),
      '<pre class="md-code-block"><code>linha 1\nlinha 2</code></pre>',
    );
  });

  it('spoiler oculta até clicar (aria/role de botão)', () => {
    const html = render('||segredo||');
    assert.ok(html.includes('role="button"'));
    assert.ok(html.includes('segredo'));
    assert.ok(!html.includes('revealed'));
  });

  it('autolink de URL http/https', () => {
    assert.equal(
      render('veja https://exemplo.com/pagina'),
      'veja <a href="https://exemplo.com/pagina" target="_blank" rel="noopener noreferrer">https://exemplo.com/pagina</a>',
    );
  });

  it('não autolinka esquemas perigosos como javascript:', () => {
    const html = render('javascript:alert(1)');
    assert.ok(!html.includes('<a href="javascript:'));
  });

  it('formatação aninhada: negrito contendo itálico', () => {
    assert.equal(render('**negrito *e itálico* junto**'), '<strong>negrito <em>e itálico</em> junto</strong>');
  });

  it('marcação não fechada permanece texto literal', () => {
    assert.equal(render('**sem fechar'), '**sem fechar');
  });
});
