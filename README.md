<div align="center">

<img src="src/ui/brand/logo.png" width="128" height="128" alt="小金同学">

# 小金同学

住在 Windows 桌面上的 AI 编程伙伴 · Live2D 桌宠 · Codex / Claude 双模式

[![下载最新版](https://img.shields.io/github/v/release/Jinkra/XJ-Agent?label=%E4%B8%8B%E8%BD%BD&color=1f6feb)](https://github.com/Jinkra/XJ-Agent/releases/latest)
![平台](https://img.shields.io/badge/Windows-10%20%2F%2011%20x64-0078d4)

</div>

小金同学是一只透明悬浮的 Live2D 桌宠，同时也是你的编程助手工作台：把任务交给小金，它会通过本机的 **Codex** 或 **Claude Code** 在指定目录里执行，进展、完成和需要你批准的操作都会用头顶气泡告诉你。

<p align="center">【小金同学形象IP为作者原创设定，受著作权法保护，未经授权禁止盗用、商用、二次改编】</p>

## 下载与激活

到 [Releases](https://github.com/Jinkra/XJ-Agent/releases/latest) 下载 `XJ-Agent-Setup-版本号-x64.exe`，运行安装向导即可。向导可选择安装目录，并可创建桌面、开始菜单和快速启动快捷方式；卸载向导可选择是否保留用户数据。

每个版本首次打开时需要输入激活码。微信搜索公众号「都拓文化」获取激活码，激活记录加密保存在本机。

在工作台「偏好设置 → 软件更新」中可检查 GitHub 新版：多线路测速下载，校验签名清单与 SHA-256 后原地更新并重启，原有快捷方式会保留。使用前请先在本机安装并登录 Codex 或 Claude Code（至少一个）。

## 功能

**桌宠**
- 自建的 Live2D 模型（网格 + 变形器绑定，不是贴图拼接）：呼吸、眨眼、环顾、目光跟随鼠标、头发 / 呆毛 / 熊猫耳的弹簧物理。
- 拖拽时像被一根绳子拎着，身体随加减速摆动，腿和衣摆有惯性；松手落地有弹跳。
- 互动：点击开心小跳、连点 3 下挥手、捏脸（脸颊真实被拉伸）、拎着猛甩会晕、戳太多会生闷气、没有任务又没人理会打瞌睡。
- 吸附四边：上下边扒着横杆探头，左右边从屏幕边缘探出小半个身子；贴边时同样可以互动。
- 待审批时挑眉、任务失败时皱眉、新提醒时会“说话”。

**工作台**
- **Codex / Claude 模式切换**，可在偏好设置里选择启动时进入哪个模式。
  - Codex：通过 `codex app-server` 连接，模型和推理强度可切换（列表来自本机 Codex）。
  - Claude：通过官方 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) 驱动本机已登录的 Claude Code，流式回复、工具活动、续接历史会话、模型与权限模式切换。
- 需要权限的操作（以及 Claude 的提问）都会出现在小金的审批弹窗里，**只有你点批准才会执行**。
- 所有任务：本机 Codex 任务列表、Claude Code 历史会话（可在小金里继续）。
- 用量小账本：Codex 额度、Claude 花费（今日 / 7 天 / 累计）、OpenAI 组织 API 费用。
- 偏好设置：开机自启、勿扰、角色大小、各项互动开关、打瞌睡时间、拖拽摆动幅度等。

## 从源码运行

需要 Windows 10/11、Node.js 20+。

```bash
npm install
npm start
```

测试与打包：

```bash
npm test          # 单元测试
npm run test:ui   # Electron 界面冒烟测试（会弹出窗口）
npm run dist      # 构建 Windows 安装包到 release/XJ-Agent-Setup-版本号-x64.exe
```

打包直接使用 `node_modules` 中已安装的 Electron，不需要再联网下载。

## Live2D 模型

模型由 `live2d/build/` 里的脚本从原画 `小金同学-透明底-human.png` 生成，结果输出到 `src/ui/live2d/xiaojin/`（标准的 moc3 / model3 / physics3 包，也能在 Cubism Viewer 中打开）。重新生成需要带 numpy、scipy、Pillow 的 Python：

```bash
cd live2d/build
python segment.py        # 按原画描边拆出 23 个部件并补画遮挡区域
python eyes_from_gen.py  # 把闭眼 / 笑眼 / 表情原画配准为覆盖层（art/gen）
python rig.py            # 网格、贴图集、变形器层级、参数与物理 → src/ui/live2d/xiaojin
python make_icons.py     # 应用图标（src/ui/brand）
```

`render.cjs`、`harness*.cjs` 用 Edge + Playwright 对模型和桌宠做无头渲染检查。

## Codex 审批提醒

在偏好设置里安装审批钩子后，到 **Codex → 设置 → Hooks**（或 CLI 的 `/hooks`）审核信任两条包含 `jinkra/hook-bridge.cjs` 的钩子，其他 Codex 会话的批准请求也会出现在小金的气泡里。小金不会自行批准任何操作。

## 数据与隐私

- 偏好设置与加密密钥保存在本机 `%APPDATA%/jinkra-companion/settings.json`；OpenAI Admin API key 使用 Windows DPAPI 加密，渲染进程无法读取。
- 钩子配置位于 `%USERPROFILE%/.codex/hooks.json`，安装时保留原有配置并备份。
- 小金只读取本机 Codex / Claude Code 的会话记录用于展示，不上传你的工作区内容。

## 目录结构

```
src/                 Electron 主进程、Codex / Claude 接入、桌宠与工作台界面
src/ui/live2d/       生成好的 Live2D 模型
src/ui/brand/        应用图标与 LOGO
live2d/build/        模型生成与校验脚本
live2d/art/          拆层结果、表情原画、图标原画
scripts/ tests/      打包脚本与测试
```

## 第三方组件

- Live2D Cubism Core（`src/ui/vendor/live2dcubismcore.min.js`）为 Live2D Inc. 的专有可再发行代码，适用 [Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)；商业发布需符合 Live2D 的许可条件。
- `live2d/build/moc3_binary.py` 取自 [image2live2d](https://github.com/Wzhang3912/image2live2d)（Apache-2.0，见同目录 LICENSE）。
- PIXI.js、pixi-live2d-display（仅用于构建时的渲染检查）、Lucide 图标均为 MIT 许可。
- Electron、@anthropic-ai/claude-agent-sdk 按各自许可使用。

小金同学的角色形象与美术素材版权归作者所有，未经许可请勿用于其他用途。
