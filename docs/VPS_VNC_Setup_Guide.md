# Project Golem: VPS Headless + VNC 一鍵部署指南

此文件整合了 `Xvfb + Fluxbox + x11vnc + noVNC` 架構，讓沒有桌面環境的 Linux/VPS 使用者可直接透過 `setup.sh` 一鍵部署。

## 1) 架構

- `Xvfb`: 建立虛擬顯示器 (`DISPLAY=:99`)
- `Fluxbox`: 輕量視窗管理器
- `x11vnc`: 將 X display 輸出為 VNC
- `websockify + noVNC`: 讓瀏覽器可直接訪問 VNC

## 2) 一鍵部署（推薦）

### Docker 容器化模式

```bash
./setup.sh --deploy-docker
```

啟動後：
- Dashboard: `http://SERVER-IP:3000`
- noVNC: `http://SERVER-IP:6080/vnc.html`

停止：

```bash
./setup.sh --headless-stop
```

### Linux 本機模式（非 Docker）

```bash
./setup.sh --deploy-linux
```

停止：

```bash
./setup.sh --headless-stop
```

## 3) 僅啟停虛擬桌面

```bash
./setup.sh --desktop-start
./setup.sh --desktop-status
./setup.sh --desktop-stop
```

相容指令（與舊教學一致）：

```bash
./start-desktop.sh
./stop-desktop.sh
```

## 4) 可選環境變數

- `GOLEM_NOVNC_PORT`（預設 `6080`）
- `GOLEM_NOVNC_BIND`（預設 `0.0.0.0`）
- `GOLEM_VNC_PORT`（預設 `5900`）
- `GOLEM_VNC_PASSWORD`（建議設定）
- `GOLEM_SCREEN_SIZE`（預設 `1280x720x24`）

範例：

```bash
GOLEM_VNC_PASSWORD='StrongPass123' GOLEM_NOVNC_PORT=7080 ./setup.sh --headless-deploy --docker
```

## 5) 安全建議

- 建議透過反向代理或 VPN 暴露 noVNC，不要直接公開在公共網路。
- 至少設定 `GOLEM_VNC_PASSWORD`。
- 若需對外開放，請搭配防火牆白名單與 HTTPS。
