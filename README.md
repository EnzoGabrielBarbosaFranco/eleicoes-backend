# Backend Eleições

## Subir o backend localmente

É necessário ter o Node.js 22 instalado.

Na primeira vez, entre na pasta do projeto e instale as dependências:

```powershell
cd C:\caminho\para\backend-eleicoes
npm ci
```

Inicie o backend:

```powershell
npm run dev
```

O backend ficará disponível em:

```text
http://localhost:8787
```

Para conferir se está funcionando, abra esse endereço no navegador ou execute:

```powershell
curl.exe http://localhost:8787/
```

Mantenha o terminal aberto enquanto estiver usando o backend localmente. Para encerrar, pressione `Ctrl+C`.

## Publicar correções e ajustes

Depois de alterar o backend, salve os arquivos e valide o projeto sem publicar:

```powershell
npm run deploy -- --dry-run
```

Na primeira publicação, autentique sua conta da Cloudflare:

```powershell
npx wrangler login
```

Crie uma vez o armazenamento dos resultados:

```powershell
npx wrangler r2 bucket create backend-eleicoes-data
```

Para publicar as correções:

```powershell
npm run deploy
```

Ao terminar, o Wrangler mostrará a URL e a versão publicada do Worker. As próximas correções podem ser publicadas repetindo:

```powershell
npm run deploy
```

### Se o PowerShell bloquear o comando `npm`

O uso de `npm.cmd` não é obrigatório. Ele só é necessário quando o PowerShell bloqueia a execução de `npm.ps1` por causa da política de execução do Windows.

Se isso acontecer, substitua apenas o comando bloqueado:

```powershell
npm.cmd ci
npm.cmd run dev
npm.cmd run deploy -- --dry-run
npx.cmd wrangler login
npx.cmd wrangler r2 bucket create backend-eleicoes-data
npm.cmd run deploy
```
