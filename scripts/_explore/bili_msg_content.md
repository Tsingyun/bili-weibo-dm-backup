<!-- ⚠ 本文件是开发期的接口调研笔记：里面的 uid / mid / 房间号 / 消息序号 / 时间戳 /
     图片直链 / 投稿号 / 正文，**全部已替换为占位值**，不来自任何真实会话。
     请勿把真实值贴回来 —— 仓库是公开的，这些字段足以定位到一个具体的人。 -->

# 私信消息类型、内容说明

## 通用消息类型

以下消息类型适用于大多数会话

### 文字消息（`msg_type=1`）

在发送私信时，请确保下面的对象合法且 `content` 项的值为非空文本，否则会提示 `请求错误`

根对象：

| 字段    | 类型 | 内容     | 备注 |
| ------- | ---- | -------- | ---- |
| content | str  | 私信内容 |      |

**示例：**

内容为 `Hello` 的文字消息

```json
{
  "content": "Hello"
}
```

### 图片消息（`msg_type=2`）

在发送私信时，请确保下面的对象合法且 `url` 项的值为 B 站的图床 url，否则会报 21037 `图片格式不合法，不要调戏接口啦` 错误

建议设置 `height` 与 `width` 属性为图片的尺寸，否则可能会导致消息显示异常

根对象：

| 字段      | 类型 | 内容       | 备注                      |
| --------- | ---- | ---------- | ------------------------- |
| url       | str  | 图片url    | 一般为 B 站图床 url       |
| height    | num  | 图片高度   | 单位：像素（非必要）      |
| width     | num  | 图片宽度   | 单位：像素（非必要）      |
| imageType | str  | 图片格式   | （非必要）                |
| original  | num  | 是否为原图 | 当本参数值为 `1` 时，APP上会出现“下载原图”按钮（非必要） |
| size      | num  | 文件大小   | 单位：千字节（非必要）    |

**示例：**

图片 `https://example.invalid/010.jpg`

```json
{
  "url": "https://example.invalid/010.jpg",
  "height": 300,
  "width": 300,
  "imageType": "jpeg",
  "original": 1,
  "size": 55.443
}
```

### 撤回消息（`msg_type=5`）

内容为目标私信的 `msg_key`

请确保目标私信存在、在撤回有效期（120 秒）里，且与发送的私信在同一会话内，只能撤回自己发送的私信

成功发送此私信后，目标私信的 `msg_status` 会变成 `1`（在前端会显示目标私信被撤回）

**示例：**

假如存在 `msg_key` 为 `1000000000000000045` 的私信 A，用户发送了 `msg_type` 为 `5` 且 `content` 为以下内容的私信 B：

```json
1000000000000000045
```

若发送成功，则私信 A 会被撤回（在前端显示该消息被撤回），并且其 `msg_status` 也会变成 `1`

### 自定义表情消息（`msg_type=6`）

结构同[图片消息](#图片消息msg_type2)

### 分享消息（`msg_type=7`）

根对象：

| 字段        | 类型 | 内容             | 备注                                                           |
| ----------- | ---- | ---------------- | -------------------------------------------------------------- |
| author      | str  | 分享内容作者     | 此项不实时更新，在发送私信时设置（非必要）                     |
| headline    | str  | 分享内容主标题   | 比 `title` 更突出；此项不实时更新，在发送私信时设置（非必要）  |
| id          | num  | 分享内容id       |                                                                |
| source      | num  | 分享内容类型     | ~~1：小视频~~（已弃用）<br />2：相簿<br />3：纯文字<br />4：直播（此类型不常用，见[分享其他内容消息](#分享其他内容消息msg_type14)）<br />5：视频<br />6：专栏<br />7：番剧（`id` 为 season_id）<br />8：音乐<br />9：国产动画（`id` 为 AV 号）<br />10：图片<br />11：动态<br />16：番剧（`id` 为 epid）<br />17：番剧 |
| source_desc | str  | 分享内容类型说明 | 仅当 `source` 值为 `16` 时有此项                               |
| thumb       | str  | 分享内容封面     | 此项不实时更新，在发送私信时设置                               |
| title       | str  | 分享内容标题     | 此项不实时更新，在发送私信时设置                               |
| url         | str  | 分享内容url      | （非必要）                                                     |
| bvid        | str  | 视频BV号         | 当 `source` 值为 `5` 时有效（非必要）                          |

**示例：**

分享 UP 主 “社会易姐QwQ” 的视频 av100000046/BV1000000047

```json
{
  "author": "示例文本11",
  "headline": "",
  "id": 100000046,
  "source": 5,
  "thumb": "https://example.invalid/011.jpg",
  "title": "示例文本12",
  "bvid": "BV1000000047"
}
```

### ~~系统撤回消息（`msg_type=8`）~~

~~此消息类型由于存在安全问题，已被弃用~~

<details>
<summary>查看此消息类型说明</summary>

此类型消息在接收时的 `msg_type` 的值为 `5`（而不是 `8`）且 `sys_cancel` 的值为 `true`，**仅在用户会话中有效；目前已不可直接发送**

内容为目标私信的 `msg_key`

请确保目标私信存在，且与发送的私信在同一会话内，只能撤回自己发送的私信；**不限制目标私信的发送时间**

成功发送此私信后，目标私信的 `msg_status` 会变成 `2`（在前端会直接隐藏目标私信，且后端也不会返回目标私信的任何信息）

</details>

### 小程序消息（`msg_type=9`）

由于 B 站并没有对外公开小程序，此消息类型不常用

根对象：

| 字段        | 类型 | 内容         | 备注                      |
| ----------- | ---- | ------------ | ------------------------- |
| avatar      | str  | 小程序图标   |                           |
| cover       | str  | 小程序封面   |                           |
| id          | str  | 小程序id     |                           |
| jump_uri    | str  | 小程序链接   |                           |
| label_cover | str  | 标签图标     |                           |
| label_name  | str  | 标签文字内容 | 一般为 `小程序`           |
| name        | str  | 小程序名称   |                           |
| title       | str  | 小程序标题   |                           |

**示例：**

分享 “主站测试专用小程序”

```json
{
  "avatar": "https://example.invalid/012.png",
  "cover": "https://example.invalid/012.png",
  "id": "bili91e3e7e93af281f9",
  "jump_uri": "https://mall.bilibili.com/miniapp/bili91e3e7e93af281f9/pages/main?___timestamp=1000000000048&_biliFrom=about_bili_message&share_medium=android&share_source=bili_message&bbid=XU8CE838022AF6625C64B2153A3EF1E571AFF&ts=1000000000049",
  "label_cover": "https://example.invalid/013.png",
  "label_name": "小程序",
  "name": "示例文本13",
  "title": "示例文本13"
}
```

### 通知消息（`msg_type=10`）

此类型消息仅可接收，**不可直接发送**

**按钮显示逻辑说明：**

- **按钮的url**：首先尝试读取 `jump_uri_config`、`jump_uri_2_config`、`jump_uri_3_config` 对象中表示当前设备类型的 url（如 `web_uri`、`android_uri` 等）；若为空值，则尝试读取 `jump_uri_config`、`jump_uri_2_config`、`jump_uri_3_config` 对象中 `all_uri` 的值；若仍为空值，则读取根对象中 `jump_uri`、`jump_uri_2`、`jump_uri_3` 的值；若仍为空值，则不显示该按钮（无论提示文字是否为空）
- **按钮提示文字**：若按钮是可见的，则先尝试读取 `jump_uri_config`、`jump_uri_2_config`、`jump_uri_3_config` 对象中 `text` 的值；若为空值，则读取根对象中 `jump_text`、`jump_text_2`、`jump_text_3` 的值；若仍为空值，则提示文字为 `查看详情`

根对象：

| 字段              | 类型  | 内容          | 备注                      |
| ----------------- | ----- | ------------- | ------------------------- |
| title             | str   | 通知标题      |                           |
| text              | str   | 通知内容      |                           |
| jump_text         | str   | 按钮1提示文字 | 若按钮1不存在则为空；若按钮1存在，此项也可能为空，此时前端显示文字为 `查看详情` |
| jump_uri          | str   | 按钮1跳转链接 | 若按钮1不存在则为空           |
| modules           | 有效时：array<br />无效时：null | 详细信息      |                           |
| jump_text_2       | str   | 按钮2提示文字 | 若按钮2不存在则为空；若按钮2存在，此项也可能为空，此时前端显示文字为 `查看详情` |
| jump_uri_2        | str   | 按钮2跳转链接 | 若按钮2不存在则为空           |
| jump_text_3       | str   | 按钮3提示文字 | 若按钮3不存在则为空；若按钮3存在，此项也可能为空，此时前端显示文字为 `查看详情` |
| jump_uri_3        | str   | 按钮3跳转链接 | 若按钮3不存在则为空           |
| notifier          | 有效时：obj<br />无效时：null | 发送者信息    |                           |
| jump_uri_config   | obj   | 按钮1配置     |                           |
| jump_uri_2_config | obj   | 按钮2配置     |                           |
| jump_uri_3_config | obj   | 按钮3配置     |                           |
| biz_content       | 有效时：obj<br />无效时：null | 扩展信息      |                           |

`modules`数组：

| 项   | 类型 | 内容          | 备注 |
| ---- | ---- | ------------- | ---- |
| 0    | obj  | 详细信息1     |      |
| n    | obj  | 详细信息(n+1) |      |
| ……   | obj  | ……            | ……   |

`modules`数组中的对象：

| 字段   | 类型 | 内容 | 备注 |
| ------ | ---- | ---- | ---- |
| title  | str  | 标题 |      |
| detail | str  | 内容 |      |

`notifier`对象：

| 字段       | 类型 | 内容       | 备注   |
| ---------- | ---- | ---------- | ------ |
| avatar_url | str  | 发送者头像 |        |
| nickname   | str  | 发送者名称 |        |
| jump_url   | str  | 发送者链接 | 可为空 |

`jump_uri_config`、`jump_uri_2_config`、`jump_uri_3_config`对象：

| 字段        | 类型 | 内容                    | 备注                 |
| ----------- | ---- | ----------------------- | -------------------- |
| all_uri     | str  | 所有设备的跳转链接      | 若按钮不存在则无此项 |
| android_uri | str  | Android客户端的跳转链接 | 若按钮不存在则无此项 |
| iphone_uri  | str  | iPhone客户端的跳转链接  | 若按钮不存在则无此项 |
| ipad_uri    | str  | iPad客户端的跳转链接    | 若按钮不存在则无此项 |
| web_uri     | str  | 网页上的跳转链接        | 若按钮不存在则无此项 |
| text        | str  | 按钮提示文字            | 若按钮不存在则为空   |

`biz_content`对象：

| 字段         | 类型 | 内容        | 备注             |
| ------------ | ---- | ----------- | ---------------- |
| cover        | str  | 封面url     |                  |
| backup_cover | str  | 备用封面url |                  |
| refresh_type | num  | （？）      | **作用尚不明确** |
| biz_type     | num  | （？）      | **作用尚不明确** |
| biz_id1      | str  | （？）      | **作用尚不明确** |
| biz_id2      | str  | （？）      | **作用尚不明确** |
| biz_status   | num  | （？）      | **作用尚不明确** |

**示例：**

直播开始提醒

```json
{
  "title": "示例文本14",
  "text": "示例文本15",
  "jump_text": "示例文本16",
  "jump_uri": "https://live.bilibili.com/10000050?broadcast_type=0&is_room_feed=1&live_from=27040",
  "modules": [{
    "title": "示例文本17",
    "detail": "2024哔哩哔哩拜年纪"
  }, {
    "title": "示例文本18",
    "detail": "2024-02-09 19:32"
  }, {
    "title": "示例文本19",
    "detail": "哔哩哔哩拜年纪"
  }],
  "jump_text_2": "",
  "jump_uri_2": "",
  "jump_text_3": "",
  "jump_uri_3": "",
  "notifier": null,
  "jump_uri_config": {
    "all_uri": "https://live.bilibili.com/10000050?broadcast_type=0&is_room_feed=1&live_from=27040",
    "text": "示例文本16"
  },
  "jump_uri_2_config": {
    "text": ""
  },
  "jump_uri_3_config": {
    "text": ""
  },
  "biz_content": {
    "cover": "",
    "backup_cover": "https://example.invalid/014.jpg",
    "refresh_type": 1,
    "biz_type": 2,
    "biz_id1": "1000000051",
    "biz_id2": "100000000000000052",
    "biz_status": 0
  }
}
```

### 视频推送消息（`msg_type=11`）

此类型消息仅可接收，**不可直接发送**；有小概率会出现即使视频存在，也只会出现 `rid`、`type`（值为 `11` 或 `8`，注意其名称后面没有下划线）和 `attach_msg` 三项的现象

根对象：

| 字段       | 类型 | 内容         | 备注                                                   |
| ---------- | ---- | ------------ | ------------------------------------------------------ |
| title      | str  | 视频标题     | 接收私信时实时更新此项，若视频失效则为空文本           |
| times      | num  | 视频时长     | 以秒为单位，接收私信时实时更新此项，若视频失效则为 `0` |
| cover      | str  | 视频封面     | 接收私信时实时更新此项，若视频失效则为空文本           |
| rid        | num  | 视频AV号     |                                                        |
| type_      | num  | （？）       | **作用尚不明确**                                       |
| desc       | str  | 视频简介     | 接收私信时实时更新此项，若视频失效则为空文本           |
| bvid       | str  | 视频BV号     |                                                        |
| view       | num  | 视频播放量   | 接收私信时实时更新此项，若视频失效则为 `0`             |
| danmaku    | num  | 视频弹幕数   | 接收私信时实时更新此项，若视频失效则为 `0`             |
| pub_date   | num  | 视频发布时间 | 秒级时间戳，若视频失效则为 `0`                         |
| attach_msg | 有效时：obj<br />无效时：null | UP主赠言     |                                                        |

`attach_msg`对象：

| 字段    | 类型 | 内容     | 备注                                           |
| ------- | ---- | -------- | ---------------------------------------------- |
| id      | num  | 赠言id   |                                                |
| content | str  | 赠言内容 | 会自动加上 `UP主赠言：` 前缀，可能包含私信表情 |

**示例：**

推送视频 av100000053/BV1000000054

```json
{
  "title": "示例文本20",
  "times": 308,
  "cover": "https://example.invalid/015.jpg",
  "rid": 100000053,
  "type_": 8,
  "desc": "示例文本21",
  "bvid": "BV1000000054",
  "view": 13492,
  "danmaku": 5,
  "pub_date": 1000000055,
  "attach_msg": null
}
```

### 专栏推送消息（`msg_type=12`）

此类型消息仅可接收，**不可直接发送**；有小概率会出现即使专栏存在，也只会出现 `rid`、`type`（值为 `12`）和 `attach_msg` 三项的现象

根对象：

| 字段        | 类型 | 内容         | 备注                                                   |
| ----------- | ---- | ------------ | ------------------------------------------------------ |
| rid         | num  | 专栏CV号     |                                                        |
| title       | str  | 专栏标题     | 接收私信时实时更新此项，若专栏失效则为 `内容已失效`    |
| summary     | str  | 专栏内容概要 | 接收私信时实时更新此项，若专栏失效则为空文本           |
| author      | str  | 专栏UP主昵称 | 接收私信时实时更新此项，若专栏失效则为空文本           |
| view        | num  | 专栏观看数   | 接收私信时实时更新此项，若专栏失效则为 `0`             |
| like        | num  | 专栏点赞数   | 接收私信时实时更新此项，若专栏失效则为 `0`             |
| reply       | num  | 专栏评论数   | 接收私信时实时更新此项，若专栏失效则为 `0`             |
| template_id | num  | （？）       | **作用尚不明确**                                       |
| image_urls  | 有效时：array<br />无效时：null | 专栏封面列表 | 接收私信时实时更新此项，若专栏失效则为 `null`        |
| attach_msg  | 有效时：obj<br />无效时：null | UP主赠言     |                                                        |
| pub_date    | num  | 专栏发布时间 | 秒级时间戳，若专栏失效则为 `0`                         |

`image_urls`数组：

| 项   | 类型 | 内容      | 备注 |
| ---- | ---- | --------- | ---- |
| 0    | str  | 封面1     |      |
| n    | str  | 封面(n+1) |      |
| ……   | str  | ……        | ……   |

`attach_msg`对象：

| 字段    | 类型 | 内容     | 备注                                           |
| ------- | ---- | -------- | ---------------------------------------------- |
| id      | num  | 赠言id   |                                                |
| content | str  | 赠言内容 | 会自动加上 `UP主赠言：` 前缀，可能包含私信表情 |

**示例：**

推送专栏 cv10000056

```json
{
  "rid": 10000056,
  "title": "示例文本22",
  "summary": "示例文本23",
  "author": "示例文本11",
  "view": 872,
  "like": 38,
  "reply": 7,
  "template_id": 4,
  "image_urls": [
    "https://example.invalid/016.jpg"
  ],
  "attach_msg": null,
  "pub_date": 1000000057
}
```

### 图片卡片消息（`msg_type=13`）

此类型消息仅可接收，**不可直接发送**

根对象：

| 字段     | 类型 | 内容                | 备注                 |
| -------- | ---- | ------------------- | -------------------- |
| pic_url  | str  | 图片url             |                      |
| jump_url | str  | 点击图片跳转到的url |                      |
| title    | str  | 文字说明            | 显示在聊天列表的文字 |

**示例：**

```json
{
  "pic_url": "https://example.invalid/017.png",
  "jump_url": "https://www.bilibili.com/h5/mall/suit/detail?navhide=1&id=66359&from=Banner",
  "title": "示例文本24"
}
```

### 分享其他内容消息（`msg_type=14`）

常见于分享直播

根对象：

| 字段   | 类型 | 内容             | 备注                             |
| ------ | ---- | ---------------- | -------------------------------- |
| author | str  | 分享内容作者     | 此项不实时更新，在发送私信时设置 |
| cover  | str  | 分享内容封面     | 此项不实时更新，在发送私信时设置 |
| desc   | str  | 分享内容简介     | 此项不实时更新，在发送私信时设置 |
| source | str  | 分享内容类型说明 | 常见的值为 `直播`                |
| title  | str  | 分享内容标题     | 此项不实时更新，在发送私信时设置 |
| url    | str  | 分享内容url      |                                  |

**示例：**

分享直播 ID 10000058

```json
{
  "author": "示例文本25",
  "cover": "https://example.invalid/018.jpg",
  "desc": "示例文本26",
  "source": "直播",
  "title": "示例文本27",
  "url": "https://live.bilibili.com/10000058?broadcast_type=0&is_room_feed=1&live_from=41000&share_medium=android&share_source=bili_message&bbid=XU8CE838022AF6625C64B2153A3EF1E571AFF&ts=1000000000059"
}
```

### 被关注时的自动推送消息（`msg_type=16`）

一般仅在开启了 B 站的 “被关注回复” 功能与勾选 “被关注后，向关注我的人推送我的往期作品” 选项（仅部分用户会显示此选项）时才会发送此类型消息，紧接在自动发送的文字消息后面

根对象：

| 字段          | 类型  | 内容             | 备注                                         |
| ------------- | ----- | ---------------- | -------------------------------------------- |
| main_title    | str   | 主标题           | 一般为 `更多宝藏内容`                        |
| reply_content | str   | 自动回复文字内容 | 仅在聊天列表中的消息概要中显示此内容，在私信内容中不显示 |
| sub_cards     | array | 推送的稿件列表   | 一般为3个                                    |

`sub_cards`数组：

| 项   | 类型 | 内容      | 备注 |
| ---- | ---- | --------- | ---- |
| 0    | obj  | 稿件1     |      |
| n    | obj  | 稿件(n+1) |      |
| ……   | obj  | ……        | ……   |

`sub_cards`数组中的对象：

| 字段      | 类型 | 内容         | 备注                             |
| --------- | ---- | ------------ | -------------------------------- |
| card_id   | num  | 稿件AV号     |                                  |
| card_type | num  | 稿件类型     | 一般为 `1`                       |
| jump_url  | str  | 稿件链接     |                                  |
| cover_url | str  | 稿件封面url  | 此项不实时更新，在发送私信时设置 |
| field1    | str  | 稿件标题     | 此项不实时更新，在发送私信时设置 |
| field2    | str  | 稿件发布时间 | 格式：`YYYY-MM-DD`               |
| field3    | str  | 字段3        | 此项不实时更新，在发送私信时设置 |
| icon3     | num  | 图标3类型    | 1：播放量<br />3：弹幕数<br />5：收藏量 |
| field4    | str  | 字段4        | 此项不实时更新，在发送私信时设置 |
| icon4     | num  | 图标4类型    | 1：播放量<br />3：弹幕数<br />5：收藏量 |

**示例：**

```json
{
  "main_title": "更多宝藏内容",
  "reply_content": "示例文本28",
  "sub_cards": [{
    "card_id": 100000060,
    "card_type": 1,
    "jump_url": "https://example.invalid/022.jpg",
    "cover_url": "https://example.invalid/019.jpg",
    "field1": "【宿舍评测】性能与便携两全 华为matebook E 2022深度体验及伪开箱",
    "field2": "2021-12-10",
    "field3": "20万",
    "icon3": 1,
    "field4": "479",
    "icon4": 3
  }, {
    "card_id": 100000061,
    "card_type": 1,
    "jump_url": "https://example.invalid/023.jpg",
    "cover_url": "https://example.invalid/020.jpg",
    "field1": "【BadApple】使用古董示波器Aron BS-601播放BadApple!!!",
    "field2": "2022-05-03",
    "field3": "15万",
    "icon3": 1,
    "field4": "297",
    "icon4": 3
  }, {
    "card_id": 100000062,
    "card_type": 1,
    "jump_url": "https://example.invalid/024.jpg",
    "cover_url": "https://example.invalid/021.jpg",
    "field1": "【拆解】华为 Matebook E 更换固态硬盘：从未见过如此好拆的二合一",
    "field2": "2023-02-24",
    "field3": "5万",
    "icon3": 1,
    "field4": "102",
    "icon4": 3
  }]
}
```

### 系统提示消息（`msg_type=18`）

此类型消息仅可接收，**不可直接发送**；由系统自动发送，但仅自己可见

根对象：

| 字段    | 类型 | 内容     | 备注                       |
| ------- | ---- | -------- | -------------------------- |
| content | str  | 提示列表 | **经过序列化后**的JSON数组 |

`content`文本经JSON解析后的数组：

| 项   | 类型 | 内容      | 备注 |
| ---- | ---- | --------- | ---- |
| 0    | obj  | 提示1     |      |
| n    | obj  | 提示(n+1) |      |
| ……   | obj  | ……        | ……   |

`content`文本经JSON解析后的数组中的对象：

| 字段      | 类型 | 内容                     | 备注        |
| --------- | ---- | ------------------------ | ----------- |
| text      | str  | 提示文字                 |             |
| color_day | str  | 浅色模式下的提示文字颜色 | HEX颜色代码 |
| color_nig | str  | 深色模式下的提示文字颜色 | HEX颜色代码 |
| jump_url  | str  | 点击提示跳转到的url      | （非必要）  |

**示例：**

若自己与对方从未聊过天，且对方未关注自己，则会有系统提示

```json
{
  "content": "[{\"text\":\"示例文本29\",\"color_day\":\"#9499A0\",\"color_nig\":\"#9499A0\"}]"
}
```

### AI 消息（`msg_type=19`）

此消息类型尚未得到广泛使用

根对象：

| 字段                | 类型 | 内容                 | 备注             |
| ------------------- | ---- | -------------------- | ---------------- |
| content             | obj  | 富文本内容           |                  |
| show_like           | bool | 是否显示点赞按钮     |                  |
| show_change         | bool | 是否显示修改内容按钮 |                  |
| gpt_session_id      | num  | GPT 会话 id          |                  |
| gpt_bind_query      | str  | （？）               | **作用尚不明确** |
| session_closed_line | str  | （？）               | **作用尚不明确** |
| voice_url           | str  | 语音 url（？）       |                  |
| sub_type            | num  | 子类型（？）         |                  |
| voice_time          | num  | 语音时长（？）       |                  |

`content`对象：

| 字段       | 类型  | 内容     | 备注             |
| ---------- | ----- | -------- | ---------------- |
| paragraphs | array | 段落列表 | 详细信息有待补充 |

**示例：**

由于 B 站尚未公开此消息类型，暂无示例

## 粉丝团消息类型

以下消息类型仅常见于粉丝团中的系统消息（`receiver_type` 为 `2` 且 `sender_uid` 为 `0`）

### 成员入群消息（`msg_type=301`）

### 成员退群消息（`msg_type=302`）

### 粉丝团冻结消息（`msg_type=303`）

### 粉丝团解散消息（`msg_type=304`）

### 粉丝团开通消息（`msg_type=305`）

### 成员入群消息（`msg_type=306`）

以上 6 种类型的消息均为以下数据类型结构

根对象：

| 字段     | 类型 | 内容     | 备注       |
| -------- | ---- | -------- | ---------- |
| group_id | num  | 粉丝团id | （非必要） |
| content  | str  | 提示文字 |            |

**示例：**

`社会易姐QwQ的应援团` 开通的消息（`msg_type=305`）

```json
{
  "group_id": 100000019,
  "content": "社会易姐QwQ的应援团开通啦 (>▽<)"
}
```

成员 `wuziqian211` 进入 `社会易姐QwQ的应援团` 的消息（`msg_type=306`）

```json
{
  "group_id": 100000019,
  "content": "欢迎wuziqian211入群"
}
```
