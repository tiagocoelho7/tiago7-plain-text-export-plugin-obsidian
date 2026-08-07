  # tiago7 Plain Text Export Plugin Obsidian v1.4.3

## Expansão de notas incorporadas

A exportação pode substituir incorporações do Obsidian pelo conteúdo real das notas:

```markdown
![[Nome da nota]]
![[Nome da nota#Cabeçalho]]
![[Nome da nota#^identificador-do-bloco]]
![[Nome da nota|Alias]]
```

- Notas inteiras são incluídas por completo, sem o frontmatter da nota incorporada.
- Incorporações de cabeçalho incluem somente o conteúdo abaixo do cabeçalho, até o próximo cabeçalho do mesmo nível ou de nível superior.
- Blocos identificados são incluídos quando o cache do Obsidian consegue resolvê-los; existe também uma resolução alternativa simples.
- Incorporações dentro de outras notas incorporadas são expandidas recursivamente.
- Ciclos são interrompidos com uma indicação como `[Incorporação circular ignorada: Nome]`.
- Imagens, PDFs, áudios e outros anexos viram uma indicação textual e nunca são lidos como Markdown.
- A resolução usa `MetadataCache.getFirstLinkpathDest`, considerando a nota de origem de cada incorporação.
- Todo título Markdown dentro de uma nota incorporada é rebaixado um nível durante a exportação: `#` vira `##`, `##` vira `###` e assim por diante.
- Em incorporações encadeadas, cada nível acrescenta mais um `#`, preservando a hierarquia entre a nota principal e as notas incorporadas.
- Títulos que aparecem dentro de blocos de código cercados por crases ou tils não são alterados.

A alteração acontece apenas na memória durante a exportação. Nenhuma nota original é modificada.

## Novas configurações

- **Expandir notas incorporadas na exportação** — ativada por padrão.
- **Indicar incorporações não encontradas** — ativada por padrão. Quando desativada, incorporações inválidas são removidas silenciosamente.

## Limpeza de marcações

Além das regras anteriores, esta versão reconhece e remove, preservando o texto interno:

```text
{h1{Texto}}
{f2{Texto}}
{u{Texto}}
{1{Texto}}
```

A exportação continua preservando títulos, listas, caixas de tarefa e tabelas conforme as configurações existentes.

## Exportação múltipla e interface

Continuam disponíveis:

- exportação da nota atual;
- cópia da nota atual como texto limpo;
- exportação de várias notas;
- pesquisa e seleção por pasta;
- prevenção de colisões de nomes;
- modal responsivo com rodapé e botões sempre visíveis.

## Compatibilidade

O plugin usa apenas APIs do Obsidian e permanece com `isDesktopOnly: false`. Não usa Node.js nem Electron em tempo de execução.
