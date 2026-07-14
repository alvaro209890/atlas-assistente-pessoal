# Atlas — Sessão 2026-07-14 (Front mais responsivo)

## 📋 Resumo

Melhorias de responsividade e enquadramento do frontend (`apps/web/src/styles.css`)
para funcionar bem em **qualquer monitor, nível de zoom e proporção de tela**, sem
reescrever o design cuidadosamente ajustado. Build, restart do `atlas-web` e publicação
(já ao vivo em https://atlas.cursar.space via Cloudflare Tunnel).

---

## 🎯 O que mudou (todas em `apps/web/src/styles.css`)

### 1. Altura de viewport dinâmica (`--vh`)
- Nova variável `--vh` = `100dvh` (dynamic viewport height) com **fallback** para `100vh`
  via `@supports (height: 100dvh)`.
- **Todas** as 16 ocorrências de `100vh` (shells de auth, onboarding, workspace, admin,
  loading, `calc(100vh - …)` do editor/grafo/brain) passaram a usar `var(--vh)`.
- **Por quê:** `100vh` não considera a barra dinâmica do navegador mobile nem o zoom,
  cortando o rodapé (barra inferior, botões de ação). `dvh` acompanha a área visível
  real → nada mais é cortado em celular, split-screen ou zoom.

### 2. Colunas do workspace fluidas
- `.workspace-grid` deixou de usar colunas fixas `230px … 334px` e passou a
  `clamp(212px, 15.5vw, 264px) … clamp(300px, 23vw, 384px)`.
- **Por quê:** as barras lateral e do painel de IA agora escalam proporcionalmente ao
  monitor/zoom, em vez de ficarem finas em telas grandes ou espremerem o conteúdo.

### 3. Breakpoint para monitores grandes (`min-width: 1728px`)
- Colunas laterais mais largas, `padding` das views maior (`clamp` até 96px), mais
  espaçamento em grids de notas/projetos/pessoas e onboarding mais largo.
- **Por quê:** em telas 2K/4K o app usa melhor o espaço, sem elementos perdidos.

### 4. Cap de largura em ultrawide (`min-width: 2200px`)
- Grids full-bleed (stats, hoje, notas, projetos, automações, inbox, settings) ganham
  `max-width: 1600px` para os cards não esticarem demais e manterem a legibilidade.

### 5. Viewports curtos (`min-width:761px and max-height:640px`)
- Em telas baixas (zoom alto, notebooks pequenos, janela dividida) o app passa a
  **rolar** em vez de cortar painéis de altura fixa; a sidebar vira `sticky`.

### 6. Higiene geral
- `-webkit-text-size-adjust: 100%` no `:root` (evita inflar fonte em mobile landscape).
- `img, svg, video, canvas { max-width: 100% }` (mídia nunca estoura o container).

> Nenhum componente `.tsx` precisou mudar — não havia altura/px inline; tudo era CSS.

---

## ✅ Validação

- `npm run typecheck -w @atlas/web` — OK
- `npm run build -w @atlas/web` — OK (CSS 97.9 kB / 18.3 kB gzip)
- Verificação ao vivo (https://atlas.cursar.space/admin, viewport 1440px): layout
  íntegro, hero + métricas + grid de 2 colunas bem enquadrados.
- Observação: o `serve.mjs` escuta em `127.0.0.1:3200` (o Chrome externo do setup
  Barrier não alcança o localhost desta máquina; a verificação foi pela URL pública).

---

## 🚀 Publicação

- `npm run build -w @atlas/web` regenerou `apps/web/dist`.
- `systemctl --user restart atlas-web` (serve o `dist` novo).
- A URL pública já responde com o CSS novo (`index-CmQ4iRnB.css`) via Cloudflare Tunnel.
- **Não há deploy automático por push** (o `ci.yml` só roda testes/build); o front é
  servido localmente pelo `atlas-web`. O push ao `main` é versionamento/backup.
