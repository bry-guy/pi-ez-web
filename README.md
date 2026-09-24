# pi-ez-web

A self-hosted web UI for [Pi](https://github.com/earendil-works/pi), the coding agent. Chat with Pi, browse your project sessions, and work with your repositories from desktop or mobile.

![pi-ez-web desktop screenshot](design/screenshots/pi-ez-web-desktop.png)

<details>
<summary>Mobile screenshot</summary>

<img src="design/screenshots/pi-ez-web-mobile.png" width="280" alt="pi-ez-web on mobile">

</details>

## Get started

Requires Docker with Compose.

```sh
git clone https://github.com/bry-guy/pi-ez-web.git
cd pi-ez-web
docker compose up --build -d
```

Open [http://localhost:3141](http://localhost:3141), connect a model provider in Settings, add a project, and start chatting. Your data is stored in a Docker volume.

> **Keep it private:** pi-ez-web has no built-in authentication or sandbox. It binds to localhost by default; don't expose it directly to the internet. See the [deployment guide](docs/deployment.md) before changing how it is accessed.

## Documentation

[Configuration](docs/configuration.md) · [Deployment](docs/deployment.md)
