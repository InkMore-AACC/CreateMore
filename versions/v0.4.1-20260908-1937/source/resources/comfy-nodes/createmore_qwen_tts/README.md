# CreateMore 的本地语音与机位节点

把本目录放入你现有的 `ComfyUI/custom_nodes`。不要把它当成另一个 ComfyUI 安装包，也不要把节点 runtime 里的依赖安装到主环境。

使用现有 ComfyUI 的 Python 执行 `setup_runtime.py --install`。安装器在节点内创建语音子进程依赖环境，复用原 Torch，不安装 ComfyUI、不修改主环境依赖。已有 runtime 时拒绝覆盖，改用 `--verify` 检查。当前用户这台电脑已配置，无须重复安装。

模型放在现有模型目录的 `TTS` 下，支持 ComfyUI 已配置的 `TTS` / `tts` 共享目录。会发现多层目录内的 Qwen3 TTS 模型，不复制已有 VoiceDesign。新安装的模型须分别为 VoiceDesign、CustomVoice、Base；克隆与情绪配音不是同一模型能力。

- 音色设计：描述声音和情绪，生成新的合成声音。
- 情绪配音：选择九种预设音色，填写表达指令。
- 克隆：输入有权使用的 1–60 秒录音，推荐填写原文。没有原文时使用仅音色特征模式。Base 不支持独立情绪指令，跟随参考声音。
- 所有模型仅从本地加载，不在生成时隐式下载或调用收费服务。
- 每次语音在独立进程运行，完成即退出；取消会终止该请求的进程树，不会按 Python 名称清理其他程序。
- 当前仅依赖官方 Qwen SDK 的推理模块，不安装其 Gradio 网页服务，不调用 SoX 命令行。没有 FlashAttention 时使用 PyTorch SDPA。

机位提示节点输出 fal 多角度 LoRA 要求的固定触发词格式，不负责下载或生成图片。实际采样在原生 ComfyUI 图中可见。

第三方许可由已安装包和模型各自提供；Qwen3 TTS SDK 与 fal 机位 LoRA 来源详见项目实施记录。本目录为 CreateMore 自编写的适配代码。
