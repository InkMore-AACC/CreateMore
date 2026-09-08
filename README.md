# CreateMore 版本备份

这是 CreateMore 的版本备份仓库。每个版本放在独立目录，旧版本不覆盖。

## 当前备份

`versions/v0.3.1-20260908-1422/`（新版）；之前各版原样保留。此版本未另行复制私人项目，之前版本中的工程备份不受影响。

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

本仓库采用私有发布。API 密钥、账号、聊天记录、运行数据、大型测试输出和当前私人画布工程不上传；不要取消 `local-only/` 的忽略规则。本地备份不能防电脑硬盘损坏，重要私人素材还应另存外接盘或你自己的网盘。
