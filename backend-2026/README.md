# Backend Eleições 2026

Worker exclusivo para a eleição de 2026. O backend de 2022 permanece separado e não é usado por este projeto.

## Subir localmente

Na primeira execução:

```powershell
cd C:\caminho\para\backend-eleicoes\backend-2026
npm ci
```

Ambiente oficial:

```powershell
npm run dev
```

Ambiente simulado do TSE:

```powershell
npm run dev:simulado
```

O Worker local fica em `http://127.0.0.1:8788`.

Para verificar:

```powershell
curl.exe "http://127.0.0.1:8788/api/status-eleicao?ano=2026"
curl.exe "http://127.0.0.1:8788/api/apuracao?ano=2026&turno=1&cargo=1&uf=br"
```

O front de 2026 deve consultar somente este Worker. Enquanto não houver carga, deve mostrar a espera de 2026, sem buscar dados de 2022. Quando `fase` for `simulado`, deve mostrar claramente `SIMULAÇÃO DO TSE — DADOS DE TESTE`.

## Testar e publicar

Valide antes de publicar:

```powershell
npm test -- --run
npm run deploy -- --dry-run
```

Publicar no ambiente oficial:

```powershell
npm run deploy
```

Durante uma janela oficial de testes, publicar temporariamente no ambiente simulado:

```powershell
npm run deploy:simulado
```

Ao terminar o teste, voltar imediatamente ao ambiente oficial:

```powershell
npm run deploy
```

Os comandos publicam o Worker `backend-eleicoes-2026` e não substituem o Worker de 2022. Se o PowerShell bloquear `npm`, use `npm.cmd` nos mesmos comandos.

O ambiente simulado usa `https://resultados-sim.tse.jus.br/simulado/simulado2026`. Os códigos de pleito e eleição são descobertos automaticamente pelo arquivo EA11 (`ele-c.json`).
