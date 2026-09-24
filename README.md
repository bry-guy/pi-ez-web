# pi-ez-web

A self-hosted web UI for [Pi](https://github.com/earendil-works/pi), the coding agent. Browse Pi sessions, chat with an agent, and work with repositories from desktop or mobile.

![pi-ez-web desktop screenshot](design/screenshots/pi-ez-web-desktop.png)

<details>
<summary>Mobile screenshot</summary>

<img src="design/screenshots/pi-ez-web-mobile.png" width="280" alt="pi-ez-web on mobile">

</details>

## Run it

You’ll need Docker with the Compose plugin. Clone the repo and start the app:

```sh
git clone https://github.com/bry-guy/pi-ez-web.git
cd pi-ez-web
docker compose up --build -d
```

Open [http://127.0.0.1:3141](http://127.0.0.1:3141); use the port you set if it differs. Compose builds the image locally and stores state in the `pi-ez-web-data` volume. No `config.json` is needed for the first start.

## First chat

1. In **Settings**, connect a model provider with its browser sign-in or API key.
2. Choose **Projects → Git URL** to clone a public HTTPS repository. For local repositories, mount the directory into the container. Private GitHub access needs server-side OAuth setup or an injected token; see [Configuration](docs/configuration.md).
3. Open the project and start a chat.

Provider credentials and app state stay in the persistent volume.

## Optional configuration

You can change the default model, project source, and GitHub owner in **Settings**. `config.json` is optional; use it to predefine project paths, hooks, or Pi packages. Compose’s `.env` file controls host port and image settings, but does not pass arbitrary variables into the app. See [Configuration](docs/configuration.md) before adding container variables or private GitHub access.

## Access from another device

Compose binds to `127.0.0.1` by default. Change the host port by setting `PI_WEB_PORT` in an optional `.env` file, for example:

```sh
PI_WEB_PORT=3142
```

After changing it, apply the setting with `docker compose up -d`. For a remote server, keep the loopback binding and connect with an SSH tunnel. If you changed the server port, replace the right-hand port below:

```sh
ssh -L 3141:127.0.0.1:3141 user@your-server
```

There is no built-in authentication or sandbox; anyone who can reach the app can run trusted commands with the service user's permissions. Don’t expose it directly to the internet. For shared access, use a TLS- and authentication-protected reverse proxy on a network limited to trusted users; it must support streaming responses.

## Data and updates

Compose stores app settings, Pi credentials, chats, repositories, and worktrees in the `pi-ez-web-data` volume. `docker compose down` keeps it; `docker compose down --volumes` deletes it. Back up the volume before upgrading. From your checkout, update and rebuild with:

```sh
git pull
docker compose up --build -d
```

See [Deployment](docs/deployment.md) for safe backup, restore, and rollback instructions.

[Configuration](docs/configuration.md) · [Deployment](docs/deployment.md)
