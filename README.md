# pi-Claudeui

Pi 的 macOS 桌面客户端。使用本机的 Pi CLI、模型配置和会话，提供白色的 Claude 风格界面、权限模式、上下文用量、会话详情和附件。

## 运行

需要 macOS 13 或更新版本、Swift 5.9 或更新版本，以及已安装并配置模型的 Pi CLI。先在终端确认 `pi --version` 可以运行。

```sh
git clone https://github.com/003jia/pi-Claudeui.git
cd pi-Claudeui
./script/build_and_run.sh
```

首次运行会在桌面创建 `Pi.app`。更新时先退出 Pi，再运行同一条脚本。脚本会查找「应用程序」和桌面的现有安装。仅验证编译和打包时可用 `./script/build_and_run.sh --build`。

## 使用

- 在聊天框底部选择工作目录、模型、思考深度和权限模式。自动模式通过 macOS 沙箱执行内置工具。选择项目目录后，工具可以在该项目内写入。个人文件夹作为工作目录时只读。
- 点击底部的用量横条可展开上下文明细。总用量来自 Pi，分类占比为估算。右上角的「会话详情」可查看工作目录、文件改动和交付物。可拖动右侧栏的分隔线调整宽度，也可拖动标题栏移动窗口。
- 点击输入框的「+」可添加图片、文本、PDF、DOCX 和 RTF。每条消息最多 4 个附件，单个附件最大 8 MB。文档以提取出的正文随消息发送，直接识图需要选用支持图片输入的模型。

Markdown 渲染使用 [Marked](https://github.com/markedjs/marked)。随附的许可见 [LICENSE.marked](Resources/Web/LICENSE.marked)。
