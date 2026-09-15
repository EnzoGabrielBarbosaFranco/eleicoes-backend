# Backend Eleições 2026

Este é um Worker separado do backend atual de demonstração. O backend existente na raiz do repositório continua atendendo 2022 sem alterações.

## Subir localmente

Na primeira vez, entre nesta pasta e instale as dependências:

```powershell
cd C:\caminho\para\backend-eleicoes\backend-2026
npm ci
```

Inicie o backend de 2026:

```powershell
npm run dev
```

Ele ficará disponível em `http://localhost:8788`. O backend atual de 2022 continua em `http://localhost:8787`, portanto os dois podem permanecer abertos ao mesmo tempo.

Para verificar:

```powershell
curl.exe http://localhost:8788/
curl.exe http://localhost:8788/api/status-eleicao?ano=2026
curl.exe http://localhost:8788/api/calendario
```

O formato dos resultados de `/api/apuracao` é compatível com o consumido atualmente pelos widgets. Entretanto, o front atual usa uma única URL tanto para 2026 quanto para o fallback de 2022. Como este Worker aceita somente 2026, não substitua diretamente a URL antiga pela nova enquanto o fallback estiver ativo.

Use duas URLs no front:

```javascript
const API_2022_LOCAL = 'http://127.0.0.1:8787';
const API_2026_LOCAL = 'http://127.0.0.1:8788';
```

- Consulte `/api/status-eleicao?ano=2026` no backend 2026.
- Se `resultadosDisponiveis` for `true`, consulte a apuração no backend 2026.
- Se for `false`, continue consultando a demonstração no backend 2022.
- Nunca envie `ano=2022` para o backend 2026; ele responderá `ANO_INVALIDO`.

Enquanto o TSE não liberar a carga, o front deve exibir a demonstração de 2022 com um aviso de que os resultados de 2026 ainda não estão disponíveis. Durante os simulados, quando `fase` for `simulado`, deve mostrar um selo visível como `SIMULAÇÃO DO TSE — DADOS DE TESTE`. Somente quando `fase` for `oficial` os dados devem ser apresentados como resultados oficiais de 2026.

## Ambiente simulado do TSE

O Worker usa o ambiente oficial por padrão. Quando o TSE divulgar a URL operacional dos simulados, altere somente estas variáveis em `wrangler.jsonc`:

```json
"TSE_ENVIRONMENT": "simulado",
"TSE_RESULTS_ROOT": "URL_DIVULGADA_PELO_TSE"
```

Não invente códigos de pleito ou eleição: o backend os descobre automaticamente pelo arquivo EA11 (`ele-c.json`).

## Testar e publicar

```powershell
npm test -- --run
npm run deploy -- --dry-run
npm run deploy
```

Esse comando publica o Worker `backend-eleicoes-2026`; ele não substitui o Worker atual `backend-eleicoes`.

Se o PowerShell bloquear `npm`, utilize `npm.cmd` nos mesmos comandos.
