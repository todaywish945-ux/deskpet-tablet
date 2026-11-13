/**
 * DSH 内嵌面板页面（http://127.0.0.1:<port>/panel 直出，无构建、单文件）。
 *
 * 是桌宠通话视图的"远程同屏"：她的动画、字幕、语音都在这里复现，
 * 大脑（LLM/TTS/会话）仍在桌宠主进程。数据通道：
 *   - WebSocket /events：主进程 pet:* 事件实时广播（tts-chunk 为 base64 PCM）
 *   - HTTP POST /chat /interrupt：发言与打断
 *   - HTTP GET /asset/*：动画/贴纸（与 petasset:// 同源同逻辑）
 *
 * 动画播放器与 PCM 播放器从 src/renderer/pet 逐行移植，仅改资产基址。
 * 面板连上时桥会通知平板静音，避免双声道。
 */

export function panelHtml(port: number, token: string): string {
  const tokenJson = JSON.stringify(token)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>桌宠 · 视频通话</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; }
  body {
    background: #101418;
    font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
    color: #e8eaf0;
    user-select: none;
  }
  #stage {
    position: absolute; inset: 0; overflow: hidden;
    display: flex; flex-direction: column;
  }
  /* 视频区：保持 0.72 取景比例。宽度封顶（不超过 100%、不超过约 2/3 窗高折算），
     高度由比例推导——任何窗口形状（哪怕被拉成通天长条）都绝不开裁、绝不特写 */
  #video-zone {
    position: relative; flex: 0 0 auto;
    width: min(100%, 47.5vh);
    aspect-ratio: 0.72;
    margin: 0 auto;
    overflow: hidden;
    background: #101418;
    transition: box-shadow 0.5s ease;
  }
  /* 她说话时的呼吸光晕（tts-start 加类、tts-end 摘掉） */
  #video-zone.speaking {
    box-shadow: 0 0 0 1px rgba(76, 208, 125, 0.35), 0 6px 26px rgba(76, 208, 125, 0.18);
    animation: speak-glow 2.2s ease-in-out infinite;
  }
  @keyframes speak-glow {
    0%, 100% { box-shadow: 0 0 0 1px rgba(76, 208, 125, 0.30), 0 6px 22px rgba(76, 208, 125, 0.14); }
    50% { box-shadow: 0 0 0 2px rgba(76, 208, 125, 0.45), 0 6px 30px rgba(76, 208, 125, 0.24); }
  }
  /* 对话区：视频下方的全部剩余空间——字幕气泡 + 输入行 */
  #chat-zone {
    position: relative; flex: 1 1 auto; min-height: 0;
    display: flex; flex-direction: column;
    padding: 10px 10px 12px; gap: 8px;
  }
  #char-layer { position: absolute; inset: 0; }
  #char-layer video {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; opacity: 0; transition: opacity 0.55s ease;
    /* 人物取景：源是 4:3（含烤入黑边）。视图框纵向拉满（黑边除外，顶边避开发梢），
       横向以脸心（水平 52%）居中——头顶红角不裁、头到腰身完整展示。
       宽高比恰等于小窗 360×500（0.72），无形变。 */
    object-view-box: inset(2.2% 22.5% 3.4% 26.5%);
  }
  /* 老内核不支持视图框：退化为 cover + 把裁剪焦点放在脸上（近似取景） */
  html.noviewbox #char-layer video {
    object-view-box: none;
    object-position: 50% 28%;
  }
  #char-layer img.char {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: contain; opacity: 0.92;
    animation: breathe 3.2s ease-in-out infinite;
  }
  @keyframes breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.015); } }
  @keyframes talk-bob { 0%,100% { transform: scale(1); } 50% { transform: scale(1.02); } }
  img.char.talk-bob { animation: talk-bob 0.62s ease-in-out infinite; }
  img.char.pop-in { animation: pop-in 0.34s ease-out; }
  @keyframes pop-in { from { transform: scale(0.72); opacity: 0; } to { transform: scale(1); opacity: 0.92; } }

  #msg-log {
    flex: 1 1 auto; min-height: 0;
    overflow-y: auto;
    display: flex; flex-direction: column; gap: 8px;
    padding-right: 2px;
  }
  .msg {
    max-width: 88%;
    padding: 8px 11px;
    border-radius: 12px;
    font-size: 13px; line-height: 1.55;
    white-space: pre-wrap; word-break: break-word;
  }
  .msg.assistant {
    align-self: flex-start;
    background: rgba(28, 32, 38, 0.92);
    border: 1px solid rgba(255,255,255,0.08);
  }
  .msg.user {
    align-self: flex-end;
    background: #2c4a94;
  }
  .msg.error {
    align-self: stretch;
    background: rgba(40, 24, 24, 0.9);
    border-color: rgba(255, 99, 99, 0.55);
    color: #ffb4b4;
  }
  #bubble.hidden { display: none; }
  #bubble.error { border-color: rgba(255, 99, 99, 0.55); color: #ffb4b4; }
  .dots i {
    display: inline-block; width: 5px; height: 5px; border-radius: 50%;
    background: #9aa3b2; margin-right: 4px;
    animation: dot 1.2s ease-in-out infinite;
  }
  .dots i:nth-child(2) { animation-delay: 0.18s; }
  .dots i:nth-child(3) { animation-delay: 0.36s; }
  @keyframes dot { 0%,60%,100% { opacity: 0.25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }

  #user-toast {
    position: absolute; top: 8px; left: 50%; transform: translateX(-50%);
    max-width: 86%;
    background: rgba(60, 64, 72, 0.9);
    border-radius: 10px;
    padding: 5px 10px;
    font-size: 12px; color: #cfd4de;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    opacity: 1; transition: opacity 0.7s ease;
  }
  #user-toast.hidden { display: none; }
  #user-toast.fade { opacity: 0; }

  #topbar {
    position: absolute; top: 0; left: 0; right: 0;
    display: flex; align-items: center; gap: 8px;
    padding: 7px 10px;
    background: linear-gradient(rgba(10,12,16,0.85), rgba(10,12,16,0));
    font-size: 11px; color: #9aa3b2;
  }
  #conn-dot { width: 7px; height: 7px; border-radius: 50%; background: #6a7280; }
  #conn-dot.on { background: #4cd07d; }
  #status-label { margin-left: auto; }
  /* DSH 活动小条：dsh 插件推快照（WS pet:dsh-activity）时显示它此刻在跑什么 */
  #dsh-chip {
    display: none;
    flex: 0 1 auto; min-width: 0;
    max-width: 55%;
    padding: 1px 8px;
    border-radius: 9px;
    background: rgba(59, 111, 224, 0.16);
    border: 1px solid rgba(90, 140, 255, 0.35);
    color: #a9c2ff; font-size: 10px; line-height: 16px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #dsh-chip.on { display: inline-block; }

  #stop-btn {
    flex: 0 0 30px; width: 30px; height: 30px; border-radius: 50%;
    border: none; cursor: pointer;
    background: rgba(60, 64, 72, 0.9); color: #e8eaf0;
    font-size: 13px; line-height: 1;
  }
  #stop-btn:hover { background: rgba(90, 94, 102, 0.95); }

  #mode-btn {
    flex: 0 0 auto;
    height: 30px;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 15px;
    background: transparent; color: #8b93a1;
    font-size: 11px;
    cursor: pointer;
    padding: 0 9px;
  }
  #mode-btn.ds { background: #2c4a94; border-color: rgba(90,140,255,0.5); color: #dfe6ff; }
  #mic-btn {
    flex: 0 0 30px; width: 30px; height: 30px; border-radius: 50%;
    border: 1px solid rgba(255,255,255,0.12);
    background: rgba(28, 32, 38, 0.92); color: #e8eaf0;
    font-size: 13px; cursor: pointer; line-height: 1;
  }
  #mic-btn.rec { background: #b84848; border-color: rgba(255,120,120,0.5); }

  #inputbar {
    flex: 0 0 auto;
    display: flex; gap: 6px; align-items: center;
  }
  #chat-input {
    flex: 1; min-width: 0;
    background: rgba(28, 32, 38, 0.92);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 17px;
    padding: 8px 12px;
    font-size: 13px; color: #e8eaf0;
    outline: none; user-select: text;
  }
  #chat-input:focus { border-color: rgba(120, 160, 255, 0.55); }
  #send-btn {
    border: none; border-radius: 17px; cursor: pointer;
    background: #3b6fe0; color: #fff;
    padding: 0 14px; font-size: 13px;
  }
  #send-btn:hover { background: #4a7ef0; }

  #audio-hint {
    position: absolute; inset: 0; z-index: 9;
    display: flex; align-items: center; justify-content: center;
    background: rgba(10, 12, 16, 0.55);
    font-size: 13px; color: #dfe4ee; cursor: pointer;
  }
  #audio-hint.hidden { display: none; }
</style>
</head>
<body>
  <div id="stage">
    <div id="video-zone">
      <div id="char-layer"></div>
      <div id="topbar">
        <span id="conn-dot"></span><span id="conn-label">连接中…</span>
        <span id="status-label"></span>
        <span id="dsh-chip"></span>
      </div>
      <div id="user-toast" class="hidden"></div>
      <div id="audio-hint" class="hidden">点击开启她的声音</div>
    </div>
    <div id="chat-zone">
      <div id="msg-log"></div>
      <form id="inputbar">
        <button id="mode-btn" type="button" title="切换输入去向：跟她说（她自己的大脑）/ 转发给DS（当前编码会话）">对她说</button>
        <input id="chat-input" type="text" placeholder="想说点什么…" autocomplete="off">
        <button id="mic-btn" type="button" title="语音输入（说完自动转文字填进输入框）">🎙</button>
        <button id="send-btn" type="submit">发</button>
        <button id="stop-btn" type="button" title="让她停下">■</button>
      </form>
    </div>
  </div>
<script>
'use strict';
var TOKEN = ${tokenJson};
var PORT = ${port};
// 老内核探测：不支持 object-view-box 就挂降级类（cover + 脸部焦点裁剪）
try {
  if (!(window.CSS && window.CSS.supports && window.CSS.supports('object-view-box', 'inset(1% 1% 1% 1%)'))) {
    document.documentElement.classList.add('noviewbox');
  }
} catch (e) { /* 保底默认 */ }

// ==================== PCM 播放器（移植自 src/renderer/pet/PcmPlayer.ts） ====================
var SAMPLE_RATE = 24000;
var PcmPlayer = /** @class */ (function () {
  function PcmPlayer() {
    this.ctx = null;
    this.nextTime = 0;
    this.sources = new Set();
    this.gains = new Set();
    this.volume = 1;
  }
  PcmPlayer.prototype.ensureContext = function () {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      this.nextTime = 0;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  };
  PcmPlayer.prototype.resumeFromGesture = function () {
    // 浏览器自动播放策略：AudioContext 要在用户手势里恢复
    this.ensureContext();
  };
  PcmPlayer.prototype.suspended = function () {
    return this.ctx !== null && this.ctx.state === 'suspended';
  };
  PcmPlayer.prototype.pushChunk = function (base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var view = new DataView(bytes.buffer);
    var sampleCount = Math.floor(bytes.length / 2);
    if (sampleCount === 0) return;
    var samples = new Float32Array(sampleCount);
    for (var j = 0; j < sampleCount; j++) samples[j] = view.getInt16(j * 2, true) / 32768;
    var ctx = this.ensureContext();
    var buffer = ctx.createBuffer(1, sampleCount, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    var source = ctx.createBufferSource();
    source.buffer = buffer;
    var gain = ctx.createGain();
    gain.gain.value = this.volume;
    source.connect(gain);
    gain.connect(ctx.destination);
    var startAt = Math.max(ctx.currentTime + 0.05, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
    var self = this;
    this.sources.add(source);
    this.gains.add(gain);
    source.onended = function () {
      self.sources.delete(source);
      self.gains.delete(gain);
      try { source.disconnect(); gain.disconnect(); } catch (e) { /* already */ }
    };
  };
  Object.defineProperty(PcmPlayer.prototype, "remainingMs", {
    get: function () {
      if (!this.ctx || this.ctx.state !== 'running') return 0;
      return Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000);
    },
    enumerable: true, configurable: true
  });
  PcmPlayer.prototype.stop = function () {
    for (var _i = 0, _a = this.sources; _i < _a.length; _i++) {
      var s = _a[_i];
      try { s.stop(); } catch (e) { /* not started */ }
    }
    this.sources.clear();
    this.gains.clear();
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close();
    this.ctx = null;
    this.nextTime = 0;
  };
  return PcmPlayer;
})();

// ==================== 动画状态机（移植自 src/renderer/pet/AnimationPlayer.ts，仅改资产基址） ====================
var ASSET = '/asset';
var EMOTION_HOLD_MS = 25000;
var FADE_S = 0.34;

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
function shuffle(list) {
  var out = list.slice();
  for (var i = out.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

var AnimationPlayer = /** @class */ (function () {
  function AnimationPlayer(container) {
    this.container = container;
    this.manifest = null;
    this.emotionMap = {};
    this.mode = 'loading';
    this.layers = [];
    this.activeLayer = 0;
    this.img = null;
    this.state = 'idle';
    this.emotion = null;
    this.emotionTimer = null;
    this.idleList = [];
    this.idleIdx = 0;
    this.settleIdx = 0;
    this.talkList = [];
    this.currentTalk = null;
    this.pendingSettle = null;
    this.settling = null;
    this.loopPoints = {};
    this.loopingClip = false;
    this.fadeToken = 0;
    this.monitorStarted = false;
    this.failStreak = 0;
    this.transitions = {};
    this.enteringTalk = null;
    this.exiting = false;
    this.finishTimer = null;
    this.holdTimer = null;
    this.lastTime = 0;
    this.stuckTicks = 0;
    this.activeLoop = null;
    this.preloadTimer = null;
    this.IDLE_STICKER = 'placeholder-idle.png';
    this.TALK_STICKER = 'placeholder-talk.png';
  }
  AnimationPlayer.prototype.init = function () {
    var _this = this;
    var bust = '?v=' + Date.now();
    return Promise.all([
      this.tryFetchJson(ASSET + '/animations/manifest.json' + bust),
      this.tryFetchJson(ASSET + '/stickers/reactions.json' + bust),
      this.tryFetchJson(ASSET + '/animations/loop-points.json' + bust)
    ]).then(function (r) {
      var manifest = r[0], reactions = r[1], points = r[2];
      if (reactions) _this.buildEmotionMap(reactions);
      if (points) _this.loopPoints = points;
      if (manifest && toArray(manifest.idle).length > 0) {
        _this.manifest = manifest;
        _this.idleList = shuffle(toArray(manifest.idle));
        _this.talkList = toArray(manifest.talk);
        _this.transitions = manifest.transitions || {};
        _this.settleIdx = 0;
        _this.mode = 'video';
        _this.setupVideoLayers();
      } else {
        _this.mode = 'placeholder';
        _this.setupPlaceholder();
      }
      _this.render(true);
    });
  };
  AnimationPlayer.prototype.tryFetchJson = function (url) {
    return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  };
  AnimationPlayer.prototype.buildEmotionMap = function (data) {
    var scenes = Object.keys((data && data.scenes) || {});
    var items = (data && data.items) || [];
    for (var _i = 0, scenes_1 = scenes; _i < scenes_1.length; _i++) {
      var scene = scenes_1[_i];
      var item = items.find(function (e) { return e.scenes && e.scenes.indexOf(scene) >= 0; });
      if (item) this.emotionMap[scene] = item.file;
    }
  };
  AnimationPlayer.prototype.pauseAll = function () {
    for (var _i = 0, _a = this.layers; _i < _a.length; _i++) _a[_i].pause();
  };
  AnimationPlayer.prototype.resumeAll = function () {
    var current = this.layers[this.activeLayer];
    if (current && current.src) void current.play().catch(function () { return undefined; });
  };
  AnimationPlayer.prototype.setTalking = function (talking) {
    var wasTalking = this.state === 'talk';
    this.state = talking ? 'talk' : 'idle';
    if (talking) {
      if (this.finishTimer) { clearTimeout(this.finishTimer); this.finishTimer = null; }
      if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
      this.settling = null;
      this.pendingSettle = null;
      this.exiting = false;
      if (this.emotionTimer) { clearTimeout(this.emotionTimer); this.emotionTimer = null; }
      this.emotion = null;
      if (this.enteringTalk) return;
      if (this.talkList.length > 0) {
        if (this.emotion && this.talkForEmotion(this.emotion)) {
          this.currentTalk = this.talkForEmotion(this.emotion);
        } else if (!this.currentTalk) {
          var prev = this.currentTalk;
          var pool = this.talkList.length > 1 ? this.talkList.filter(function (f) { return f !== prev; }) : this.talkList;
          this.currentTalk = pool[Math.floor(Math.random() * pool.length)];
        }
      }
      var style = this.currentTalk;
      var tr = style ? this.transitions[style] : null;
      if (tr && tr.enter && !wasTalking) {
        this.enteringTalk = style;
        this.showVideo(ASSET + '/animations/' + tr.enter, { loop: false }, true, 200);
        this.preloadHidden(ASSET + '/animations/' + style, 300);
        return;
      }
    } else if (this.emotion) {
      return;
    } else if (this.currentTalk && this.manifest && this.manifest.settle && this.manifest.settle[this.currentTalk]) {
      this.pendingSettle = this.manifest.settle[this.currentTalk];
      this.loopingClip = false;
      this.activeLoop = null;
      this.preloadSettle(this.pendingSettle);
      return;
    }
    if (!talking && this.emotion) return;
    this.render();
  };
  AnimationPlayer.prototype.preloadTalk = function () {
    if (this.mode !== 'video' || this.talkList.length === 0) return;
    if (this.state === 'talk' || this.enteringTalk) return;
    if (!this.currentTalk) {
      if (this.emotion && this.talkForEmotion(this.emotion)) {
        this.currentTalk = this.talkForEmotion(this.emotion);
      } else {
        var pool = this.talkList.length > 1 ? this.talkList.filter(function (f) { return f !== this.currentTalk; }) : this.talkList;
        this.currentTalk = pool[Math.floor(Math.random() * pool.length)];
      }
    }
    var style = this.currentTalk;
    if (!style) return;
    var tr = this.transitions[style];
    var hidden = this.layers[1 - this.activeLayer];
    var url = ASSET + '/animations/' + (tr && tr.enter ? tr.enter : style);
    if (hidden.src === url) return;
    hidden.loop = false;
    hidden.oncanplay = null;
    hidden.src = url;
    hidden.load();
  };
  AnimationPlayer.prototype.preloadHidden = function (url, delayMs) {
    var _this = this;
    if (delayMs === void 0) { delayMs = 900; }
    setTimeout(function () {
      if (_this.mode !== 'video') return;
      var hidden = _this.layers[1 - _this.activeLayer];
      if (_this.layers[_this.activeLayer] === hidden) return;
      if (hidden.src === url) return;
      hidden.loop = false;
      hidden.oncanplay = null;
      hidden.src = url;
      hidden.load();
    }, delayMs);
  };
  AnimationPlayer.prototype.finishTalkingAt = function (msUntilAudioEnd) {
    var _this = this;
    this.state = 'idle';
    this.pendingSettle = null;
    this.settling = null;
    var tr = this.currentTalk ? this.transitions[this.currentTalk] : null;
    if (tr && tr.exit) {
      this.loopingClip = false;
      this.activeLoop = null;
      var hidden = this.layers[1 - this.activeLayer];
      var exitUrl = ASSET + '/animations/' + tr.exit;
      var dur = hidden.src === exitUrl && isFinite(hidden.duration) && hidden.duration > 0 ? hidden.duration : 0.7;
      var delay = Math.max(0, msUntilAudioEnd / 1000 - dur);
      if (this.finishTimer) clearTimeout(this.finishTimer);
      this.finishTimer = setTimeout(function () {
        _this.finishTimer = null;
        _this.exiting = true;
        _this.showVideo(exitUrl, { loop: false }, true, 250);
        var idleFile = _this.idleList[_this.idleIdx];
        if (idleFile) _this.preloadHidden(ASSET + '/animations/' + idleFile, 450);
        _this.currentTalk = null;
      }, delay * 1000);
      return;
    }
    this.loopingClip = false;
    this.activeLoop = null;
    var transitionMs = Math.min(600, Math.max(200, msUntilAudioEnd));
    var delay = Math.max(0, msUntilAudioEnd - transitionMs);
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = setTimeout(function () {
      _this.finishTimer = null;
      _this.render(true, 450);
    }, delay);
  };
  AnimationPlayer.prototype.cancelFinishTimer = function () {
    if (this.finishTimer) { clearTimeout(this.finishTimer); this.finishTimer = null; }
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
  };
  AnimationPlayer.prototype.setEmotion = function (name) {
    var _this = this;
    this.emotion = name;
    if (this.emotionTimer) clearTimeout(this.emotionTimer);
    this.emotionTimer = setTimeout(function () {
      _this.emotion = null;
      _this.render();
    }, EMOTION_HOLD_MS);
    if (this.talkList.length > 0) {
      this.currentTalk = this.talkForEmotion(name) || this.currentTalk;
    }
    this.render();
  };
  AnimationPlayer.prototype.cycleIdle = function () {
    if (this.mode !== 'video' || this.idleList.length <= 1) return;
    this.idleIdx = (this.idleIdx + 1) % this.idleList.length;
    this.render(true);
  };
  AnimationPlayer.prototype.setupVideoLayers = function () {
    var _this = this;
    var _loop_1 = function (i) {
      var video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.style.opacity = '0';
      video.addEventListener('ended', function () {
        if (video === _this.layers[_this.activeLayer]) _this.onClipFinished(video);
      });
      video.addEventListener('error', function () {
        if (video === _this.layers[_this.activeLayer]) {
          _this.failStreak++;
          if (!_this.emotion && _this.idleList.length > 0) {
            _this.idleIdx = (_this.idleIdx + 1) % _this.idleList.length;
          }
          _this.onClipFinished(video);
        }
      });
      _this.container.appendChild(video);
      _this.layers.push(video);
    };
    for (var i = 0; i < 2; i++) { _loop_1(i); }
    this.startMonitor();
  };
  AnimationPlayer.prototype.onClipFinished = function (endedVideo) {
    var _this = this;
    if (this.enteringTalk && endedVideo && endedVideo === this.layers[this.activeLayer]) {
      var talk = this.enteringTalk;
      this.enteringTalk = null;
      if (this.state === 'talk') {
        this.showVideo(ASSET + '/animations/' + talk, { loop: true }, true, 120);
        var tr = this.transitions[talk];
        if (tr && tr.exit) this.preloadHidden(ASSET + '/animations/' + tr.exit);
      } else {
        if (this.holdTimer) clearTimeout(this.holdTimer);
        this.holdTimer = setTimeout(function () {
          _this.holdTimer = null;
          if (_this.state !== 'talk' && !_this.enteringTalk) {
            _this.currentTalk = null;
            _this.render();
          }
        }, 12000);
      }
      return;
    }
    if (this.exiting && endedVideo && endedVideo === this.layers[this.activeLayer]) {
      this.exiting = false;
      this.render();
      return;
    }
    if (!this.settling && this.pendingSettle && endedVideo && endedVideo === this.layers[this.activeLayer]) {
      var file = this.pendingSettle;
      this.pendingSettle = null;
      this.settling = file;
      this.showVideo(ASSET + '/animations/' + file, { loop: false }, true);
      return;
    }
    if (this.settling) this.settling = null;
    if (this.emotion) {
      if (this.emotionTimer) clearTimeout(this.emotionTimer);
      this.emotionTimer = null;
      this.emotion = null;
    }
    this.render();
  };
  AnimationPlayer.prototype.startMonitor = function () {
    var _this = this;
    if (this.monitorStarted) return;
    this.monitorStarted = true;
    var tick = function () {
      if (_this.mode === 'video') {
        _this.checkLoopPoints();
        _this.checkLoopFade();
        _this.checkStuck();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  AnimationPlayer.prototype.checkStuck = function () {
    var cur = this.layers[this.activeLayer];
    if (!cur.src || cur.paused) { this.stuckTicks = 0; return; }
    if (Math.abs(cur.currentTime - this.lastTime) > 0.001) {
      this.lastTime = cur.currentTime;
      this.stuckTicks = 0;
      return;
    }
    this.stuckTicks++;
    if (this.stuckTicks > 90) {
      this.stuckTicks = 0;
      this.settleIdx = 0;
      var old = this.layers;
      this.layers = [];
      this.activeLayer = 0;
      this.fadeToken++;
      this.loopingClip = false;
      for (var _i = 0, old_1 = old; _i < old_1.length; _i++) {
        var v = old_1[_i];
        try { v.pause(); } catch (e) { /* 忽略 */ }
        v.removeAttribute('src');
        v.load();
        v.remove();
      }
      this.setupVideoLayers();
      this.render(true);
    }
  };
  AnimationPlayer.prototype.checkLoopPoints = function () {
    if (!this.loopingClip || !this.activeLoop) return;
    var cur = this.layers[this.activeLayer];
    if (!cur.src || cur.paused || cur.ended) return;
    if (cur.readyState < 2) return;
    if (cur.currentTime >= this.activeLoop.loopOut) {
      cur.currentTime = this.activeLoop.loopIn;
    }
  };
  AnimationPlayer.prototype.checkLoopFade = function () {
    var _this = this;
    if (!this.loopingClip || this.activeLoop) return;
    var cur = this.layers[this.activeLayer];
    if (!cur.src || cur.paused || cur.ended || cur.loop) return;
    var duration = cur.duration;
    if (!isFinite(duration) || duration <= 0.6) return;
    if (duration - cur.currentTime > FADE_S) return;
    var token = ++this.fadeToken;
    this.loopingClip = false;
    var next = this.layers[1 - this.activeLayer];
    var swap = function () {
      next.oncanplay = null;
      if (token !== _this.fadeToken) return;
      next.style.opacity = '1';
      cur.style.opacity = '0';
      _this.activeLayer = 1 - _this.activeLayer;
      _this.loopingClip = true;
      void next.play().then(function () {
        setTimeout(function () {
          if (token === _this.fadeToken && _this.layers[_this.activeLayer] !== cur) cur.pause();
        }, 750);
      }).catch(function () { return undefined; });
    };
    if (next.src === cur.src && next.readyState >= 3) {
      swap();
    } else {
      next.src = cur.src;
      next.oncanplay = swap;
      next.load();
    }
  };
  AnimationPlayer.prototype.setupPlaceholder = function () {
    var img = document.createElement('img');
    img.className = 'char';
    img.draggable = false;
    this.container.appendChild(img);
    this.img = img;
  };
  AnimationPlayer.prototype.currentEmotionClip = function () {
    if (!this.emotion) return null;
    return (this.manifest && this.manifest.emotions && this.manifest.emotions[this.emotion]) || null;
  };
  AnimationPlayer.prototype.currentIdleClip = function () {
    if (this.idleList.length === 0) return null;
    return ASSET + '/animations/' + this.idleList[this.idleIdx % this.idleList.length];
  };
  AnimationPlayer.prototype.talkForEmotion = function (emotion) {
    var _this = this;
    var pick = function (file) { return (_this.talkList.indexOf(file) >= 0 ? file : null); };
    if (['celebrate', 'encourage', 'playful', 'thanks', 'welcome', 'morning', 'agree'].indexOf(emotion) >= 0) {
      return pick('talk_04_loop.mp4');
    }
    if (['shy', 'apology'].indexOf(emotion) >= 0) return pick('talk_face.mp4');
    if (['affection', 'moved', 'comfort', 'care', 'reassure', 'patience'].indexOf(emotion) >= 0) {
      return pick('talk_squint.mp4');
    }
    if (['neutral', 'listen', 'thinking', 'curious', 'sad', 'sleepy', 'night', 'tired', 'rest'].indexOf(emotion) >= 0) {
      return pick('talk_standby.mp4');
    }
    return pick('talk_standby.mp4');
  };
  AnimationPlayer.prototype.render = function (force, fadeMs) {
    if (this.mode === 'loading') return;
    if (this.pendingSettle) return;
    if (this.mode === 'placeholder') {
      var emotionFile = this.emotion ? this.emotionMap[this.emotion] : null;
      var file = emotionFile || (this.state === 'talk' ? this.TALK_STICKER : this.IDLE_STICKER);
      this.showSticker(ASSET + '/stickers/' + file, emotionFile != null, !!force);
      return;
    }
    var emotionClip = this.currentEmotionClip();
    if (emotionClip) {
      this.showVideo(ASSET + '/animations/' + emotionClip, { loop: false }, !!force, fadeMs);
      return;
    }
    if (this.settling) {
      this.showVideo(ASSET + '/animations/' + this.settling, { loop: false }, !!force, fadeMs);
      return;
    }
    if (this.state === 'talk' && this.currentTalk) {
      this.showVideo(ASSET + '/animations/' + this.currentTalk, { loop: true }, !!force, fadeMs !== undefined ? fadeMs : 150);
      return;
    }
    if (this.state === 'idle' && this.currentTalk) this.currentTalk = null;
    if (this.failStreak >= this.idleList.length) return;
    var idle = this.currentIdleClip();
    if (idle) this.showVideo(idle, { loop: true }, !!force, fadeMs);
  };
  AnimationPlayer.prototype.showVideo = function (src, opts, force, fadeMs) {
    var _this = this;
    var current = this.layers[this.activeLayer];
    var nativeLoop = opts.loop && !this.loopPoints[src.split('/').pop() || ''];
    if (!force && current.src === src && !current.paused && !current.ended) {
      this.loopingClip = opts.loop;
      var file = src.split('/').pop() || '';
      this.activeLoop = opts.loop && !nativeLoop ? (this.loopPoints[file] || null) : null;
      current.loop = nativeLoop;
      return;
    }
    var token = ++this.fadeToken;
    this.loopingClip = opts.loop;
    var fileName = src.split('/').pop() || '';
    this.activeLoop = opts.loop && !nativeLoop ? (this.loopPoints[fileName] || null) : null;
    var next = this.layers[1 - this.activeLayer];
    next.loop = nativeLoop;
    next.oncanplay = null;
    var swap = function () {
      next.oncanplay = null;
      if (token !== _this.fadeToken) return;
      if (fadeMs !== undefined) {
        next.style.transitionDuration = fadeMs + 'ms';
        current.style.transitionDuration = fadeMs + 'ms';
      } else {
        next.style.transitionDuration = '';
        current.style.transitionDuration = '';
      }
      // 显形与播放解耦：切层立即完成（暂停也显示当前帧，绝不黑屏）；
      // play() 只是让画面动起来，被宿主拦/被遮挡暂停时由看门狗提示恢复
      next.style.opacity = '1';
      current.style.opacity = '0';
      _this.activeLayer = 1 - _this.activeLayer;
      var finalize = function () {
        if (token !== _this.fadeToken) return;
        setTimeout(function () {
          if (token === _this.fadeToken && _this.layers[_this.activeLayer] !== current) current.pause();
        }, 750);
        if (_this.state === 'idle' && !_this.emotion && !_this.settling && !_this.pendingSettle) {
          _this.scheduleTalkPreload();
        }
        if (_this.state === 'talk' && _this.currentTalk) {
          var tr = _this.transitions[_this.currentTalk];
          if (tr && tr.exit) _this.preloadHidden(ASSET + '/animations/' + tr.exit);
        }
      };
      void next.play().then(finalize, function () {
        // 起播被拦（自动播放策略）：已显形出首帧；看门狗会提示用户点一下
        finalize();
      });
    };
    if (next.src === src && next.readyState >= 3) {
      swap();
    } else {
      next.src = src;
      next.oncanplay = swap;
      next.load();
    }
  };
  AnimationPlayer.prototype.scheduleTalkPreload = function () {
    var _this = this;
    if (this.preloadTimer) clearTimeout(this.preloadTimer);
    if (this.talkList.length === 0) return;
    this.preloadTimer = setTimeout(function () {
      _this.preloadTimer = null;
      if (_this.mode !== 'video' || _this.state !== 'idle' || _this.emotion) return;
      var hidden = _this.layers[1 - _this.activeLayer];
      var url = ASSET + '/animations/' + _this.talkList[0];
      if (hidden.src === url || hidden.readyState >= 3) return;
      hidden.loop = false;
      hidden.oncanplay = null;
      hidden.src = url;
      hidden.load();
    }, 700);
  };
  AnimationPlayer.prototype.preloadSettle = function (file) {
    var hidden = this.layers[1 - this.activeLayer];
    var url = ASSET + '/animations/' + file;
    if (hidden.src === url) return;
    hidden.loop = false;
    hidden.oncanplay = null;
    hidden.src = url;
    hidden.load();
  };
  AnimationPlayer.prototype.showSticker = function (src, isEmotion, force) {
    var img = this.img;
    if (!img) return;
    var cls = isEmotion ? 'pop-in' : this.state === 'talk' ? 'talk-bob' : 'breathe';
    if (!force && img.src === src && img.className.indexOf(cls) >= 0) return;
    if (img.src !== src) img.src = src;
    img.className = 'char ' + cls;
  };
  return AnimationPlayer;
})();

// ==================== 面板胶水：WS 事件流 + 对话轮日志 + 输入 ====================
var el = function (id) { return document.getElementById(id); };
var msgLog = el('msg-log');
var userToast = el('user-toast');
var connDot = el('conn-dot');
var connLabel = el('conn-label');
var statusLabel = el('status-label');
var inputEl = el('chat-input');
var audioHint = el('audio-hint');

var pcm = new PcmPlayer();
var player = new AnimationPlayer(el('char-layer'));
void player.init();

var shownEmotion = null;
var hadAudioThisTurn = false;
var userToastTimer = null;
var subtitleMode = true; // 配了语音时字幕逐句跟音频出；没配则流式上屏（/health 里确认）

function displayFilter(text) {
  return String(text).replace(/\\[emotion[：:][a-z_]*\\]?/gi, '').trim();
}

// ---------- 对话轮日志 ----------
function scrollLog() {
  msgLog.scrollTop = msgLog.scrollHeight;
}
function addMsg(role, text, extraClass) {
  var d = document.createElement('div');
  d.className = 'msg ' + (extraClass || role);
  d.textContent = text;
  msgLog.appendChild(d);
  scrollLog();
  return d;
}
// 她本轮的流式气泡：thinking 先出思考点，句子/增量逐段写入，turn 结束定稿
var streamingEl = null;
var streamingText = '';
function startAssistant() {
  streamingEl = addMsg('assistant', '');
  streamingText = '';
  streamingEl.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
}
function appendAssistant(text) {
  if (!streamingEl) streamingEl = addMsg('assistant', '');
  streamingText += text;
  streamingEl.textContent = streamingText;
  scrollLog();
}
function finishAssistant(fullText, isError) {
  if (!streamingEl) return;
  var text = fullText === undefined ? streamingText : fullText;
  if (!text) {
    streamingEl.remove(); // 空轮（被打断且什么都没说）：不留空泡
  } else {
    streamingEl.textContent = text;
    if (isError) streamingEl.classList.add('error');
  }
  streamingEl = null;
  streamingText = '';
  scrollLog();
}
function showEmotion(name) {
  if (name === shownEmotion) return;
  shownEmotion = name;
  player.setEmotion(name);
}
function setConnected(on) {
  connDot.classList.toggle('on', on);
  connLabel.textContent = on ? '已连接' : '连接中…';
}
function setStatus(text) {
  statusLabel.textContent = text || '';
}

var handlers = {
  'pet:state': function (state) {
    if (state === 'thinking') startAssistant();
  },
  'pet:user-message': function (text) { addMsg('user', displayFilter(String(text))); },
  'pet:llm-delta': function (delta) {
    if (subtitleMode) return; // 字幕模式：正文由 pet:sentence 跟音频逐句出
    appendAssistant(String(delta));
  },
  'pet:sentence': function (sentence) {
    appendAssistant(String(sentence));
  },
  'pet:emotion': function (name) { showEmotion(String(name)); },
  'pet:llm-done': function (payload) {
    var text = payload && payload.text, emotion = payload && payload.emotion;
    // 字幕模式 llm-done 不带正文（句子还在跟音频出）：气泡留着，等 tts-end 定稿
    if (text) finishAssistant(displayFilter(text));
    showEmotion(emotion);
  },
  'pet:tts-preload': function () { player.preloadTalk(); },
  'pet:tts-start': function () {
    hadAudioThisTurn = false;
    setStatus('正在说话');
    var vz = document.getElementById('video-zone');
    if (vz) vz.classList.add('speaking');
    player.setTalking(true);
  },
  'pet:tts-chunk': function (chunk) {
    hadAudioThisTurn = true;
    pcm.pushChunk(String(chunk));
    if (pcm.suspended()) showHint('点击开启她的声音', 'voice');
  },
  'pet:interrupt': function () {
    pcm.stop();
    hadAudioThisTurn = false;
    player.cancelFinishTimer();
    if (streamingEl) finishAssistant(); // 半截话就停在半截（有内容），空泡直接收走
  },
  'pet:tts-end': function () {
    setStatus('');
    var vz = document.getElementById('video-zone');
    if (vz) vz.classList.remove('speaking');
    if (streamingEl && streamingText) finishAssistant(); // 字幕模式的收稿时点：音频播完，句子都出完了
    if (!hadAudioThisTurn) { player.setTalking(false); return; }
    player.finishTalkingAt(pcm.remainingMs);
  },
  'pet:tts-error': function (message) {
    // 合成失败：句子会在 reveal 时照常进日志，这里只标错误样式（不重复加一条）
    if (streamingEl) streamingEl.classList.add('error');
  },
  'pet:dsh-activity': function (snap) {
    // dsh 干活的实时小条：跑什么工具、跑了几轮；收尾就收掉
    var chip = document.getElementById('dsh-chip');
    if (!chip) return;
    if (snap && snap.running) {
      var parts = ['DSH'];
      if (snap.turn !== null && snap.turn !== undefined) parts.push('#' + snap.turn);
      parts.push(snap.currentTool ? snap.currentTool : '运行中');
      if (snap.toolsDone) parts.push(snap.toolsDone + ' 工具');
      if (snap.lastError) parts.push('有报错');
      chip.textContent = parts.join(' · ');
      chip.classList.add('on');
    } else {
      chip.classList.remove('on');
    }
  },
  'pet:error': function (message) {
    var text = String(message);
    startAssistant();
    finishAssistant(/API key|401|Unauthorized/i.test(text) ? '先去桌宠设置里把 API Key 配好：' + text : '这轮没连上：' + text, true);
  },
  'pet:config-changed': function () {
    void fetch('/health').then(function (r) { return r.json(); }).then(function (h) {
      subtitleMode = !!(h && h.ttsReady);
    }).catch(function () { /* 保持现状 */ });
  }
};

// 连上后铺当前会话的近期对话轮（重连也会重新铺，保证和桌宠一致）
function seedHistory() {
  var qs = TOKEN ? '?token=' + encodeURIComponent(TOKEN) : '';
  fetch('/history' + qs, { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (h) {
      if (!h || !h.ok) return;
      msgLog.innerHTML = '';
      streamingEl = null;
      streamingText = '';
      var list = h.messages || [];
      for (var i = 0; i < list.length; i++) addMsg(list[i].role, list[i].content);
    })
    .catch(function () { /* 离线就先空着，事件来了照样记 */ });
}

function authHeaders() {
  // x-pet-bridge 是控制桥的防伪头：面板是同源页，带上它才能走 POST
  var h = { 'content-type': 'application/json', 'x-pet-bridge': '1' };
  if (TOKEN) h['authorization'] = 'Bearer ' + TOKEN;
  return h;
}

// ---------- 输入去向：跟她说 / 转发给 DS ----------
var dsMode = false;
var modeBtn = el('mode-btn');
modeBtn.addEventListener('click', function () {
  dsMode = !dsMode;
  modeBtn.classList.toggle('ds', dsMode);
  modeBtn.textContent = dsMode ? '发给DS' : '对她说';
  inputEl.placeholder = dsMode ? '对编码助手说…（直接进当前会话）' : '想说点什么…';
});

function forwardToDS(text) {
  // 面板是 iframe：经 postMessage 托付给 dsh 页面里的插件 client 半边，
  // 由它走 sessions.scope(current).conversation.send 注入当前编码会话
  if (window.parent === window) {
    addMsg('assistant', '（转发给DS只在 dsh 内嵌面板里可用——独立窗口里没有那个通道）', 'error');
    return;
  }
  addMsg('user', text, 'user'); // 先进日志（转发标记见 ack）
  window.parent.postMessage({ type: 'dsh-pet-to-ds', text: text }, '*');
}

// dsh 侧的回执：失败时补一条错误说明
window.addEventListener('message', function (event) {
  var data = event.data;
  if (!data || data.type !== 'dsh-pet-to-ds-ack') return;
  if (!data.ok) addMsg('assistant', '（转发失败：' + (data.error || '未知原因') + '）', 'error');
});

// ---------- 双击视频区 = 摸摸头/点点屏幕（复用桌宠 petPat 链路） ----------
var lastTapAt = 0;
el('video-zone').addEventListener('dblclick', function (event) {
  event.preventDefault();
  var now = Date.now();
  if (now - lastTapAt < 300) return;
  lastTapAt = now;
  var rect = event.currentTarget.getBoundingClientRect();
  var zone = event.clientY - rect.top < rect.height * 0.38 ? 'head' : 'body';
  fetch('/pat', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ zone: zone }) })
    .then(function (r) { return r.json(); })
    .then(function (body) {
      if (body.busy) showUserToast('她正在说话，先听她说完');
    })
    .catch(function () { /* 桌宠不在就算了 */ });
});

// ---------- 语音输入：桌宠代录（面板 iframe 不碰麦克风权限）----------
// 点 🎙 → /mic/start（桌宠开始录音）→ 再点一次 → /mic/stop（拿回 wav）→ /asr 转写 → 填输入框
// 状态以桥为准（/mic/start 对卡住的旧代录自动作废重开，永不 409 锁死）；忘点停止 60 秒自动收
var micBtn = el('mic-btn');
var micRecording = false;

micBtn.addEventListener('click', function () {
  if (micRecording) {
    micRecording = false;
    micBtn.classList.remove('rec');
    showUserToast('识别中…');
    fetch('/mic/stop', { method: 'POST', headers: authHeaders(), body: '{}' })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        if (!body.ok) throw new Error(body.error || '录音失败');
        return fetch('/asr', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ audioBase64: body.audioBase64 }) })
          .then(function (r2) { return r2.json(); })
          .then(function (asrBody) {
            if (!asrBody.ok) throw new Error(asrBody.error || '转写失败');
            if (!asrBody.text) { showUserToast('没听清，再试一次？'); return; }
            inputEl.value = inputEl.value ? inputEl.value + ' ' + asrBody.text : asrBody.text;
            inputEl.focus();
            showUserToast('说好了，自己确认一下再发');
          });
      })
      .catch(function (err) {
        showUserToast('语音输入失败：' + (err && err.message ? err.message : '未知原因'));
      });
    return;
  }
  fetch('/mic/start', { method: 'POST', headers: authHeaders(), body: '{}' })
    .then(function (r) { return r.json(); })
    .then(function (body) {
      if (!body.ok) throw new Error(body.error || '录音启动失败');
      micRecording = true;
      micBtn.classList.add('rec');
      showUserToast('在听…再点一次结束');
      setTimeout(function () {
        if (micRecording) micBtn.click(); // 60 秒忘停自动收
      }, 60000);
    })
    .catch(function (err) {
      showUserToast('语音输入启动失败：' + (err && err.message ? err.message : '未知原因'));
    });
});

function connect() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var qs = TOKEN ? '?token=' + encodeURIComponent(TOKEN) : '';
  var ws = new WebSocket(proto + '//' + location.host + '/events' + qs);
  ws.onopen = function () {
    setConnected(true);
    seedHistory(); // 每次连上都重新铺：以桌宠的会话为准
  };
  ws.onmessage = function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    var handler = handlers[msg.channel];
    if (handler) handler.apply(null, msg.args || []);
  };
  ws.onclose = function () {
    setConnected(false);
    setTimeout(connect, 2500); // 桌宠重启后面板自动重连
  };
  ws.onerror = function () { try { ws.close(); } catch (e) { /* noop */ } };
}

// ---------- 看门狗：当前显示的视频若停摆（被宿主暂停/没解码出来），提示点击恢复 ----------
var videoStuckTicks = 0
var hintReason = '' // 'voice'（要手势开声）| 'video'（画面停摆）| ''（无）
function showHint(text, reason) {
  audioHint.textContent = text;
  audioHint.classList.remove('hidden');
  hintReason = reason;
}
function hideHint() {
  audioHint.classList.add('hidden');
  hintReason = '';
}
setInterval(function () {
  var layers = document.querySelectorAll('#char-layer video');
  var cur = null;
  for (var i = 0; i < layers.length; i++) {
    if (layers[i].style.opacity === '1') { cur = layers[i]; break; }
  }
  if (!cur || !cur.src) { videoStuckTicks = 0; return; }
  var stuck = cur.paused || cur.readyState < 2;
  if (!stuck) {
    videoStuckTicks = 0;
    // 画面自己恢复（比如宿主解除节流）：把画面类提示悄悄收掉，不打扰
    if (hintReason === 'video') hideHint();
    return;
  }
  videoStuckTicks++;
  if (videoStuckTicks < 3) return; // 连续 6 秒停摆才提示（说话间隙/收口瞬间不误报）
  videoStuckTicks = 0;
  showHint('画面停住了，点一下恢复', 'video');
}, 2000);

// 用户手势：恢复声音 + 把停摆的视频重新播起来；点了还停就整页重载
audioHint.addEventListener('click', function () {
  pcm.resumeFromGesture();
  var layers = document.querySelectorAll('#char-layer video');
  var stillPaused = false;
  for (var i = 0; i < layers.length; i++) {
    if (!layers[i].src) continue;
    if (layers[i].paused) {
      try { layers[i].play().catch(function () { /* 保持，靠重载兜底 */ }); } catch (e) { /* noop */ }
      stillPaused = stillPaused || layers[i].paused;
    }
  }
  hideHint();
  if (stillPaused) setTimeout(function () { location.reload(); }, 400);
});
document.addEventListener('pointerdown', function () {
  pcm.resumeFromGesture();
  // 声音类提示在手势后自动收掉（画面类由看门狗管理）
  if (hintReason === 'voice' && !pcm.suspended()) hideHint();
}, { once: true });

el('inputbar').addEventListener('submit', function (event) {
  event.preventDefault();
  var text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  if (dsMode) {
    forwardToDS(text); // 转发给 DS：经 dsh 页面的插件 client 半边注入当前会话
    return;
  }
  fetch('/chat', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: text }) })
    .then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
    .then(function (res) {
      if (res.body && res.body.busy) showUserToast('她正在说话，等一下再发');
      else if (res.status !== 200) showUserToast((res.body && res.body.error) || '没发出去');
    })
    .catch(function () { showUserToast('没连上桌宠'); });
});

el('stop-btn').addEventListener('click', function () {
  fetch('/interrupt', { method: 'POST', headers: authHeaders(), body: '{}' }).catch(function () { /* noop */ });
});

// 启动：确认语音引擎（决定字幕模式），再连事件流
void fetch('/health').then(function (r) { return r.json(); }).then(function (h) {
  subtitleMode = !!(h && h.ttsReady);
}).catch(function () { /* 离线也不影响 WS 重连 */ });
connect();
</script>
</body>
</html>`
}
