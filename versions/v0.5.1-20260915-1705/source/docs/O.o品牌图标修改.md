# O.o 品牌图标 · 0.1.1

本轮仅修改品牌图标与启动入口。原 V5 草图及 GitHub 中的 `v0.1.0-20260907-1650` 备份不变。

原左上角为文字 C 加箭头。新标志使用准确的 `O.o` 字符：白色大 O、浅青色句点和小 o、深色底，扁平化图形。软件仍叫 CreateMore。

## 统一位置

- 左上角：`app/ui/assets/brand/oo-logo.png`，32px 显示。
- 窗口与 EXE：`app/ui/assets/brand/oo-logo.ico`，包含 16、24、32、48、64、128、256px。
- 启动：项目根目录的 `启动 CreateMore.lnk` 使用新 EXE 内嵌图标；原 `.cmd` 保留兼容，但 Windows 不支持给单个 `.cmd` 独立设置图标。
- 图像母版：`app/ui/assets/brand/oo-logo-master.png`。

## 制作方式

使用内置图像生成工具制作，并根据检查结果做了一次去除棋盘格背景的定向修订。最终提示词要求：保留 `O.o` 三个字符和基线关系，白色大 O、浅青色句点与小 o，整张深炭色底，纯平面，移除棋盘格、阴影、渐变、浮雕、纹理及额外符号。

PNG 到 Windows 多尺寸 ICO 是尺寸与格式转换；与界面使用同一份图像。没有安装新的运行时依赖，没有修改模型、账号、生成工作流或私人画布。

## 验证结果

- 326 项自动测试通过，含新增 2 项品牌绑定与 ICO 格式检查；产品脚本语法检查通过。
- 最终 EXE：`dist/CreateMore-0.1.1-20260907093512-win32-x64/CreateMore.exe`。7 个内嵌图标帧与原 ICO 逐字节一致，程序内 PNG／ICO 与源文件一致。
- 隔离实际启动退出码 0；左上角图标已加载，替代文本 `O.o`，显示 32×32，旧的倾斜变换已去除。截图与报告在该交付目录 `.test-output/electron-smoke.png`、`electron-smoke.json`。
- 快捷方式已回读核对目标、图标路径和图标序号，均指向新 EXE；没有改变 Windows 文件关联或脚本执行策略。
- 发现旧程序中的用户自定义裁切工具和图像工作流，因此将 5 份差异文件原样复制到新程序资源目录并核对哈希。旧目录、原画布和 GitHub 旧备份未修改。记录：`testing-output/brand-user-resource-preservation.json`。
- `testing-output/release-integrity.json` 是复制用户自定义资源之前的 256 文件核对。复制后 `image-zimage/current.json` 有意沿用用户版本，而非出厂版本；不将其误报为仍与出厂资源完全相同。

当前旧窗口不会被强制关闭或重载。请先保存并退出旧窗口，再使用带 O.o 图标的新快捷方式启动。
