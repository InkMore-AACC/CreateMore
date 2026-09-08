# CreateMore — Windows 本地创作画布

CreateMore 是连接 ComfyUI 本地生成、Codex 和 Image2 的创作画布，采用 [MIT 许可证](LICENSE) 开源。当前处于交互重构和功能验收阶段，并非所有功能均已完成验证。

本仓库按版本保存源码，每个版本放在独立目录，旧版本不覆盖。

## 获取与运行

最新源码：[v0.5.0](versions/v0.5.0-20260909-0508/source)。在安装 Node.js 和 npm 的 Windows 电脑上：

```powershell
git clone https://github.com/InkMore-AACC/CreateMore.git
cd CreateMore/versions/v0.5.0-20260909-0508/source
npm ci
npm start
```

运行检查：`npm test`、`npm run check`。打包：`npm run build`，完整程序输出到 `dist/版本目录/Windows-app/`，需整体移动，不能只复制 EXE。本仓库暂未提供可下载的打包发行版。

ComfyUI、Python、模型、第三方节点及 Codex/API 登录由每位用户自行配置，不随源码提供。历史文档中的本机路径、端口与测试记录不代表下载者已具备该环境。详细说明见对应版本的 README 和 docs。

## 开源与反馈

仓库根目录的 MIT 许可适用于作者拥有版权的 CreateMore 代码，包括这里保存的历史版本；旧快照中的 `UNLICENSED` 和“私有发布”文字是历史元数据，由本次明确授权取代，不改写备份内容和校验清单。第三方内容保持原许可，见 [第三方许可说明](THIRD_PARTY_NOTICES.md)。

欢迎通过 [Issues](https://github.com/InkMore-AACC/CreateMore/issues) 报告问题或提交 Pull Request。请说明版本、复现步骤和预期行为；不要上传 API 密钥、账号信息或私人工程素材。

## 当前备份

`versions/v0.5.0-20260909-0508/`（最新交互与卡片架构版）；之前各版原样保留。该版完成普通／生成卡片分离、全局本地工作流自动路由、固定式生成框和图片／视频比例自适应。355 项完整自动测试与 38 项正式 EXE 界面回归通过；聚焦高清工作流已在当前本机 ComfyUI 真实输出 1024×1024 PNG。功能实跑与待确认范围见版本内文档。

本机 `local-only/` 还保存了当前“画布测试”工程的原样副本和可迁移副本；打包前按工程已存 SHA-256 找回了一张移动到 AAA 的同内容素材。私人项目和完整 Windows-app 仍受忽略规则保护，不上传 GitHub。

- `source/`：软件源码、已批准的 V5 草图、默认工作流、测试、说明和公开范围内的验收示例；同步到 GitHub。
- `source-manifest.json`：每个源文件的大小和 SHA-256，用于检查备份是否完整。
- `local-only/Windows-app/`：可直接运行的 Windows 软件完整目录；仅保留在本机，不提交 GitHub。
- `local-only/current-project-original/`：选择备份工程时保存的原样副本，仅本地；不是每个版本都有。
- `local-only/current-project-portable/`：选择备份工程时创建的可迁移副本，仅本地；不是每个版本都有。
- `打开备份软件.cmd`：在本机运行该版本；从 GitHub 单独下载的源码不含运行程序。

## 给设计师的使用方法

打开 GitHub Desktop，左上角选择 **CreateMore**。

1. **History** 是已经保存的版本记录。
2. **Changes** 是尚未保存成版本的修改。
3. **Commit to main** 是在本机记一份版本。
4. **Push origin** 才是上传到 GitHub；显示 **Fetch origin** 且没有待推送数量时，再核对线上提交一致。

后续继续在原工作目录修改软件；要存新版本时新建另一个带版本号的目录，不覆盖本次备份。此仓库不会自动跟随原目录变化。

本仓库采用公开发布。API 密钥、账号、聊天记录、运行数据、大型测试输出和当前私人画布工程不上传；不要取消 `local-only/` 的忽略规则。公开仓库不是私人素材备份位置。本地备份不能防电脑硬盘损坏，重要私人素材还应另存外接盘或你自己的网盘。
