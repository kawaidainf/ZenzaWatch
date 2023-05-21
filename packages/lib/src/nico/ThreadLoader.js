import {util} from '../util';
import {PopupMessage} from '../util';
// import jsdom from 'jsdom';
import {sleep} from '../../packages/lib/src/infra/sleep';
import {netUtil} from '../../../lib/src/infra/netUtil';
import {textUtil} from '../../../lib/src/text/textUtil';
import {nicoUtil} from '../../../lib/src/nico/nicoUtil';

const JSDOM = {} ; //jsdom.JSDOM;
const debug = {};

//===BEGIN===

const {ThreadLoader} = (() => {
  const VERSION_OLD = '20061206';
  const VERSION     = '20090904';
  const FRONT_ID = '6';
  const FRONT_VER = '0';

  const FORK_LABEL = {
    0: 'main',
    1: 'owner',
    2: 'easy',
  }

  class ThreadLoader {

    constructor() {
      this._threadKeys = {};
    }

    /**
     * 動画の長さに応じて取得するコメント数を変える
     * 本家よりちょっと盛ってる
     */
    getRequestCountByDuration(duration) {
      if (duration < 60)  { return 100; }
      if (duration < 240) { return 200; }
      if (duration < 300) { return 400; }
      return 1000;
    }

    async getThreadKey(videoId, options = {}) {
      let url = `https://nvapi.nicovideo.jp/v1/comment/keys/thread?videoId=${videoId}`;

      console.log('getThreadKey url: ', url);
      const headers = Object.assign({
        'X-Frontend-Id': FRONT_ID,
        'X-Frontend-Version': FRONT_VER,
      }, options.cookie ? {Cookie: options.cookie} : {});
      try {
        const { meta, data } = await netUtil.fetch(url, {
          headers,
          credentials: 'include'
        }).then(res => res.json());
        if (meta.status !== 200) {
          throw meta
        }
        this._threadKeys[videoId] = data.threadKey;
        return data
      } catch (result) {
        throw { result, message: `ThreadKeyの取得失敗 ${videoId}` }
      }
    }

    async getPostKey(threadId, options = {}) {
      const url = `https://nvapi.nicovideo.jp/v1/comment/keys/post?threadId=${threadId}`;

      console.log('getPostKey url: ', url);
      const headers = Object.assign({
        'X-Frontend-Id': FRONT_ID,
        'X-Frontend-Version': FRONT_VER,
      }, options.cookie ? {Cookie: options.cookie} : {});
      try {
        const { meta, data } = await netUtil.fetch(url, {
          headers,
          credentials: 'include'
        }).then(res => res.json());
        if (meta.status !== 200) {
          throw meta
        }
        return data
      } catch (result) {
        throw { result, message: `PostKeyの取得失敗 ${threadId}` }
      }
    }

    async _post(url, body, options = {}) {
      const headers = {
        'X-Frontend-Id': FRONT_ID,
        'X-Frontend-Version': FRONT_VER,
        'Content-Type': 'text/plain; charset=UTF-8'
      };
      try {
        const { meta, data } = await netUtil.fetch(url, {
          method: 'POST',
          dataType: 'text',
          headers,
          body
        }).then(res => res.json());
        if (meta.status !== 200) {
          throw meta
        }
        return data;
      } catch (result) {
        throw {
          result,
          message: `コメントの通信失敗`
        }
      }
    }

    async _load(msgInfo, options = {}) {
      const {
        params,
        threadKey
      } = msgInfo.nvComment;

      const packet = {
        additionals: {},
        params,
        threadKey
      };

      if (options.retrying) {
        const info = await this.getThreadKey(msgInfo.videoId, options);
        console.log('threadKey: ', msgInfo.videoId, info);
        packet.threadKey = info.threadKey;
      }

      if (msgInfo.when > 0) {
        packet.additionals.when = msgInfo.when;
      }

      const url = 'https://nvcomment.nicovideo.jp/v1/threads';
      console.log('load threads...', url, packet);
      const headers = {
        'X-Frontend-Id': FRONT_ID,
        'X-Frontend-Version': FRONT_VER,
        'Content-Type': 'text/plain; charset=UTF-8'
      };
      try {
        const { meta, data } = await netUtil.fetch(url, {
          method: 'POST',
          dataType: 'text',
          headers,
          body: JSON.stringify(packet)
        }).then(res => res.json());
        if (meta.status !== 200) {
          throw meta;
        }
        return data;
      } catch (result) {
        throw {
          result,
          message: `コメントの通信失敗`
        }
      }
    }

    async load(msgInfo, options = {}) {
      const videoId = msgInfo.videoId;
      const userId   = msgInfo.userId;

      const timeKey = `loadComment videoId: ${videoId}`;
      console.time(timeKey);

      let result;
      try {
        result = await this._load(msgInfo, options);
      } catch (e) {
        console.timeEnd(timeKey);
        window.console.error('loadComment fail 1st: ', e);
        PopupMessage.alert('コメントの取得失敗: 3秒後にリトライ');

        await sleep(3000);
        try {
          console.time(timeKey);
          const result = await this._load(msgInfo, { retrying: true, ...options });
        } catch (e) {
          console.timeEnd(timeKey);
          window.console.error('loadComment fail finally: ', e);
          throw {
            message: 'コメントサーバーの通信失敗'
          }
        }
      }

      console.timeEnd(timeKey);
      debug.lastMessageServerResult = result;

      let totalResCount = result.globalComments[0].count;
      let threadId;
      for (const thread of result.threads) {
        threadId = parseInt(thread.id, 10);
        const forkLabel = thread.fork;
        // 投稿者コメントはGlobalにカウントされていない
        if (forkLabel === 'easy') {
          // かんたんコメントをカウントしていない挙動に合わせる。不要？
          const resCount = thread.commentCount;
          totalResCount -= resCount;
        }
      }

      const threadInfo = {
        userId,
        videoId,
        threadId,
        is184Forced:   msgInfo.defaultThread.is184Forced,
        totalResCount,
        language:   msgInfo.language,
        when:       msgInfo.when,
        isWaybackMode: !!msgInfo.when
      };

      msgInfo.threadInfo = threadInfo;

      console.log('threadInfo: ', threadInfo);
      return {threadInfo, body: result, format: 'threads'};
    }

    async postChat(msgInfo, text, cmd, vpos, retrying = false) {
      const {
        videoId,
        threadId,
        language
      } = msgInfo.threadInfo;
      const url = `https://nvcomment.nicovideo.jp/v1/threads/${threadId}/comments`
      const { postKey } = await this.getPostKey(threadId, { language });

      const packet = JSON.stringify({
        body: text,
        commands: cmd?.split(/[\x20\xA0\u3000\t\u2003\s]+/) ?? [],
        vposMs: Math.floor((vpos || 0) * 10),
        postKey,
        videoId,
      });
      console.log('post packet: ', packet);
      try {
        const { no, id } = await this._post(url, packet);
        return {
          status: 'ok',
          no,
          id,
          message: 'コメント投稿成功'
        };
      } catch (error) {
        const { status, errorCode } = error;
        if (status == null) {
          throw {
            status: 'fail',
            message: `コメント投稿失敗`
          };
        }
        if (!retrying && ['INVALID_TOKEN', 'EXPIRED_TOKEN'].includes(errorCode)) {
          await this.load(msgInfo);
        } else {
          throw {
            status: 'fail',
            statusCode: status,
            message: `コメント投稿失敗 ${errorCode}`
          };
        }
        await sleep(3000);
        return await this.postChat(msgInfo, text, cmd, vpos, true)
      }
    }

    async getNicoruKey(threadId, options = {}) {
      const url = `https://nvapi.nicovideo.jp/v1/comment/keys/nicoru?threadId=${threadId}`;

      console.log('getNicoruKey url: ', url);
      const headers = Object.assign({
        'X-Frontend-Id': FRONT_ID,
        'X-Frontend-Version': FRONT_VER,
        'X-Niconico-Language': options.language || 'ja-jp'
      }, options.cookie ? {Cookie: options.cookie} : {});
      try {
        const { meta, data } = await netUtil.fetch(url, {
          headers,
          credentials: 'include'
        }).then(res => res.json());
        if (meta.status !== 200) {
          throw meta
        }
        return data
      } catch (result) {
        throw { result, message: `NicoruKeyの取得失敗 ${threadId}` }
      }
    }

    async nicoru(msgInfo, chat) {
      const {
        videoId,
        threadId,
        language
      } = msgInfo.threadInfo;
      const url = `https://nvcomment.nicovideo.jp/v1/threads/${threadId}/nicorus`;
      const { nicoruKey } = await this.getNicoruKey(threadId, { language });
      const packet = JSON.stringify({
        content: chat.text,
        fork: FORK_LABEL[chat.fork || 0],
        no: chat.no,
        nicoruKey,
        videoId,
      });
      console.log('post packet: ', packet);
      try {
        return await this._post(url, packet); // { nicoruId, nicoruCount }
      } catch (error) {
        const { status = 'fail', errorCode } = error;
        throw {
          status,
          message: errorCode ? `ニコれなかった＞＜ ${errorCode}` : 'ニコれなかった＞＜'
        };
      }
      return result;
    }
  }

  return {ThreadLoader: new ThreadLoader};
})();




//===END===

export {ThreadLoader};
