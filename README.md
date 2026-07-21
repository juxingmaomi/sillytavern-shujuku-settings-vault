# 数据库配置保险箱

为 SillyTavern 酒馆助手用户脚本“蚀心入魔·数据库”提供服务器端的定点备份、恢复、撤销和变化报告。

当前识别的数据库设置字段：

```text
extension_settings.__userscripts.shujuku_v120__userscript_settings_v1
```

## 功能

- 显示前端和后端版本号。
- 把服务器当前数据库配置保存为基准。
- 只恢复数据库配置块，不恢复整份旧 `settings.json`。
- 每次恢复前自动完整备份当前 `settings.json`。
- 可撤销最近一次恢复。
- 比较当前配置与基准配置，生成已遮蔽敏感字段的变化报告。
- 主报告使用中文功能名称，允许显示用户自定义的 API 预设名称；技术字段默认折叠。
- 报告不显示 API 地址、Key、Token、密码、邮箱、Cookie 或授权信息。
- 只有点击“检查变化”时才保存报告，最多保留最近 20 份。
- 旧基准历史最多保留 10 份。
- 恢复和撤销前的完整 `settings.json` 安全备份合计最多保留 5 份。
- 操作记录最多保留 200 条，最近一次撤销数据只保留 1 份。
- 自动清理只匹配本插件创建的专用文件名，不会删除 SillyTavern 自带的设置备份。
- 按需扫描最近的 SillyTavern 设置备份，显示数据库配置状态切换。
- 手动更新前端和后端；更新操作不会自动重启 SillyTavern。

## 安全边界

- 后端不接受用户提交的文件路径或设置字段路径。
- 只允许操作代码中固定的数据库设置字段。
- 写入前后校验数据库之外的设置哈希，发现变化会立即停止。
- 恢复后再次读取文件验证；验证失败时自动放回恢复前的完整备份。
- 变化报告不会输出 API Key、Token、密码、授权头或凭据内容。
- 插件不修改聊天记录、人物卡、世界书、预设或其他扩展设置。
- 插件不常驻轮询，不会为了监控而持续读写硬盘。

## 界面

面板位于 SillyTavern 的扩展设置区域，包括：

- 保存为基准
- 恢复基准
- 撤销恢复
- 检查变化
- 导出报告
- 手动更新

## 安装

本项目同时包含前端扩展与服务器插件，两部分都需要安装。

前端扩展使用 SillyTavern 的“安装扩展程序”功能安装：

```text
https://github.com/juxingmaomi/sillytavern-shujuku-settings-vault
```

服务器插件在 SillyTavern 根目录安装：

```powershell
node plugins.js install https://github.com/juxingmaomi/sillytavern-shujuku-settings-vault.git
```

需要在 `config.yaml` 中启用：

```yaml
enableServerPlugins: true
```

安装后端服务器插件后，需要按原有方式正常重启一次 SillyTavern。插件面板中的更新按钮不会主动重启后台。

## 正确使用顺序

1. 在网络稳定的电脑端确认数据库的 API、向量、召回和重排设置正确。
2. 点击“保存为基准”。
3. 设置异常时，先关闭手机和其他电脑上的酒馆页面。
4. 点击“恢复基准”。
5. 重新加载当前页面，再逐一打开其他设备。

已经打开的旧页面仍可能持有旧设置。插件可以安全恢复服务器文件，但无法阻止另一个旧页面随后向 SillyTavern 提交整份旧设置。

## 开发检查

```powershell
node --check index.js
node --check ui/index.js
node --test test/*.test.js
```
