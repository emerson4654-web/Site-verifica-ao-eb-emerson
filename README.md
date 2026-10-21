# Site de Verificação EB — arquivos na raiz

Este projeto foi organizado para o GitHub/Render sem a pasta `public`. Os arquivos `index.html`, `style.css`, `app.js`, `server.js`, `package.json` e `.env.example` ficam todos na raiz do repositório.

## Arquivos

- `index.html`: interface do site.
- `style.css`: estilos.
- `app.js`: interações da página.
- `server.js`: servidor Express, login Discord, vínculo Roblox, banco e integração com o bot.
- `package.json`: dependências e comando de início.
- `.env.example`: modelo das variáveis necessárias.

## Publicar no Render

1. Envie todos os arquivos deste ZIP diretamente para a raiz do repositório GitHub. Não crie uma pasta `public`.
2. Crie ou atualize um Web Service no Render usando esse repositório.
3. Build Command: `npm install`.
4. Start Command: `npm start`.
5. Configure as variáveis listadas em `.env.example` no painel Environment do Render.
6. Adicione o endereço real do site em `BASE_URL` e cadastre exatamente o mesmo `DISCORD_REDIRECT_URI` nas configurações OAuth2 da aplicação Discord.
7. Configure `DATABASE_URL` para um PostgreSQL persistente.
8. Configure `BOT_API_URL` para o endpoint público do servidor de integração do bot e compartilhe `VERIFICATION_WEBHOOK_SECRET` com ele.

## Variáveis essenciais

- `BASE_URL`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI`
- `SESSION_SECRET`
- `DATABASE_URL`
- `GUILD_ID`
- `BOT_API_URL`
- `VERIFICATION_WEBHOOK_SECRET`
- `ROBLOX_GROUP_ID` (grupo EB: `13616747`)

Nunca publique tokens, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET` ou `VERIFICATION_WEBHOOK_SECRET` em repositório público. `.env.example` contém apenas valores de exemplo.

## Nota

Este ZIP contém o site. O bot Discord é executado e hospedado separadamente. O site não pode operar a sincronização no servidor sem o bot estar online, com as variáveis de integração configuradas e as permissões/cargos adequados.
