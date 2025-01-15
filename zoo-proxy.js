const fs = require("fs");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const readline = require("readline");
const crypto = require("crypto");
const { DateTime } = require("luxon");
const { HttpsProxyAgent } = require("https-proxy-agent");
const user_agents = require("./config/userAgents");
const settings = require("./config/config");
const { sleep, loadData, getRandomNumber, findOptimalElement } = require("./utils");
const { checkBaseUrl } = require("./checkAPI");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

class ZooAPIClient {
  constructor(queryId, accountIndex, proxy, baseURL) {
    this.headers = {
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
      "Content-Type": "application/json",
      Origin: "https://game.zoo.team",
      Referer: "https://game.zoo.team/",
      "Sec-Ch-Ua": '"Not/A)Brand";v="99", "Google Chrome";v="115", "Chromium";v="115"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
      "Is-Beta-Server": "null",
    };
    this.cachedData = null;
    this.proxyList = [];
    this.loadProxies();
    this.session_name = null;
    this.session_user_agents = this.#load_session_data();
    this.baseURL = baseURL;
    this.queryId = queryId;
    this.accountIndex = accountIndex;
    this.proxy = proxy;
    this.proxyIP = null;
  }
  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }

    this.log(`Generating user agent...`);
    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Unknown";
  }

  set_headers() {
    const platform = this.#get_platform(this.#get_user_agent());
    this.headers["sec-ch-ua"] = `"Not)A;Brand";v="99", "${platform} WebView";v="127", "Chromium";v="127`;
    this.headers["sec-ch-ua-platform"] = platform;
    this.headers["User-Agent"] = this.#get_user_agent();
  }

  createUserAgent() {
    try {
      const telegramauth = this.queryId;
      const userData = JSON.parse(decodeURIComponent(telegramauth.split("user=")[1].split("&")[0]));
      this.session_name = userData.id;
      this.#get_user_agent();
    } catch (error) {
      this.log(`Can't create user agent, try get new query_id: ${error.message}`, "error");
      return;
    }
  }

  loadProxies() {
    try {
      const proxyFile = path.join(__dirname, "proxy.txt");
      if (fs.existsSync(proxyFile)) {
        this.proxyList = fs.readFileSync(proxyFile, "utf8").replace(/\r/g, "").split("\n").filter(Boolean);
      }
    } catch (error) {
      this.log("Error loading proxies: " + error.message, "error");
    }
  }

  async checkProxyIP(proxy) {
    try {
      const proxyAgent = new HttpsProxyAgent(proxy);
      const response = await axios.get("https://api.ipify.org?format=json", {
        httpsAgent: proxyAgent,
        timeout: 10000,
      });
      if (response.status === 200) {
        return response.data.ip;
      } else {
        throw new Error(`Unable to check proxy IP. Status code: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Error when checking proxy IP: ${error.message}`);
    }
  }

  getAxiosConfig(index) {
    if (this.proxyList.length > 0 && index < this.proxyList.length) {
      return {
        httpsAgent: new HttpsProxyAgent(this.proxyList[index]),
        timeout: 30000,
      };
    }
    return { timeout: 30000 };
  }

  async createApiHash(timestamp, data) {
    const combinedData = `${timestamp}_${data}`;
    const encodedData = encodeURIComponent(combinedData);
    return crypto.createHash("md5").update(encodedData).digest("hex");
  }

  async login(initData, accountIndex) {
    if (!initData) {
      return { success: false, error: "initData is required" };
    }

    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }

      const currentTime = Math.floor(Date.now() / 1000);
      const userData = JSON.parse(decodeURIComponent(initData.split("user=")[1].split("&")[0]));
      const startParam = initData.split("start_param=")[1]?.split("&")[0] || "";
      const chatInstance = initData.split("chat_instance=")[1]?.split("&")[0] || "";

      const payload = {
        data: {
          initData: initData,
          startParam: startParam,
          photoUrl: userData.photo_url || "",
          platform: "android",
          chatId: "",
          chatType: "channel",
          chatInstance: chatInstance,
        },
      };

      const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));
      const headers = {
        ...this.headers,
        "api-hash": apiHash,
        "Api-Key": hash,
        "Api-Time": currentTime,
      };

      const response = await axios.post(`${this.baseURL}/telegram/auth`, payload, {
        headers,
        ...this.getAxiosConfig(accountIndex),
      });

      if (response.status === 200 && response.data.success) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async finishOnboarding(initData, accountIndex) {
    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }

      const currentTime = Math.floor(Date.now() / 1000);
      const payload = { data: 1 };
      const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));

      const headers = {
        ...this.headers,
        "api-hash": apiHash,
        "Api-Key": hash,
        "Api-Time": currentTime,
      };

      const response = await axios.post(`${this.baseURL}/hero/onboarding/finish`, payload, {
        headers,
        ...this.getAxiosConfig(accountIndex),
      });

      if (response.status === 200 && response.data.success) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getUserData(initData, accountIndex) {
    if (!initData) {
      return { success: false, error: "initData is required" };
    }

    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }

      const currentTime = Math.floor(Date.now() / 1000);
      const dataPayload = JSON.stringify({ data: {} });
      const apiHash = await this.createApiHash(currentTime, dataPayload);

      const headers = {
        ...this.headers,
        "api-hash": apiHash,
        "Api-Key": hash,
        "Api-Time": currentTime,
      };

      const response = await axios.post(
        `${this.baseURL}/user/data/all`,
        { data: {} },
        {
          headers,
          ...this.getAxiosConfig(accountIndex),
        }
      );

      if (response.status === 200 && response.data.success) {
        this.cachedData = response.data.data;
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getUserDataAfter(initData, accountIndex) {
    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }

      const currentTime = Math.floor(Date.now() / 1000);
      const dataPayload = JSON.stringify({ data: {} });
      const apiHash = await this.createApiHash(currentTime, dataPayload);

      const headers = {
        ...this.headers,
        "api-hash": apiHash,
        "Api-Key": hash,
        "Api-Time": currentTime,
      };

      const response = await axios.post(
        `${this.baseURL}/user/data/after`,
        { data: {} },
        {
          headers,
          ...this.getAxiosConfig(accountIndex),
        }
      );

      if (response.status === 200 && response.data.success) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async claimDailyReward(initData, rewardIndex, accountIndex) {
    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }

      const currentTime = Math.floor(Date.now() / 1000);
      const payload = { data: rewardIndex };
      const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));

      const headers = {
        ...this.headers,
        "api-hash": apiHash,
        "Api-Key": hash,
        "Api-Time": currentTime,
      };

      const response = await axios.post(`${this.baseURL}/quests/daily/claim`, payload, {
        headers,
        ...this.getAxiosConfig(accountIndex),
      });

      if (response.status === 200 && response.data.success) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async AnswerDaily(hash, accountIndex, questKey, checkData) {
    const url = `${this.baseURL}/quests/check`;
    const currentTime = Math.floor(Date.now() / 1000);
    const payload = { data: [questKey, checkData] };
    const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));

    const headers = {
      ...this.headers,
      "api-hash": `${apiHash}`,
      "Api-Key": `${hash}`,
      "Api-Time": `${currentTime}`,
    };

    try {
      const response = await axios.post(url, payload, { headers, ...this.getAxiosConfig(accountIndex) });
      if (response.status === 200 && response.data.success) {
        return await this.claimQuest(hash, accountIndex, questKey, checkData);
      } else {
        this.log(`Quest check "${questKey}" failed: ${response.data.error}`, "warning");
        return { success: false, error: response.data.error };
      }
    } catch (error) {
      this.log(`Error checking quest"${questKey}": ${error.message}`, "error");
      return { success: false, error: error.message };
    }
  }

  async getAliance(hash, accountIndex) {
    const url = `${this.baseURL}/alliance/rating`;
    const currentTime = Math.floor(Date.now() / 1000);
    const payload = {};
    const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));

    const headers = {
      ...this.headers,
      "api-hash": `${apiHash}`,
      "Api-Key": `${hash}`,
      "Api-Time": `${currentTime}`,
    };

    try {
      const response = await axios.post(url, payload, { headers, ...this.getAxiosConfig(accountIndex) });
      if (response.status === 200 && response.data.success) {
        return response.data;
      }
    } catch (error) {
      this.log(`Error when getting Alliance: ${error.message}`, "error");
      return { success: false, error: error.message };
    }
  }

  async joinAliance(hash, accountIndex, id) {
    const url = `${this.baseURL}/alliance/join`;
    const currentTime = Math.floor(Date.now() / 1000);
    const payload = { data: id };
    const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));

    const headers = {
      ...this.headers,
      "api-hash": `${apiHash}`,
      "Api-Key": `${hash}`,
      "Api-Time": `${currentTime}`,
    };

    try {
      const response = await axios.post(url, payload, { headers, ...this.getAxiosConfig(accountIndex) });
      if (response.status === 200 && response.data.success) {
        // const { alliance } = response.data;
        this.log(`Join aliance success!`, "success");
        return response.data;
      }
    } catch (error) {
      this.log(`Error when joining Alliance: ${error.message}`, "error");
      return { success: false, error: error.message };
    }
  }

  async handleAliance(initData, accountIndex) {
    this.log(`Checking aliance avaliable...`);
    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        return;
      }

      const userDataResult = await this.getUserData(initData, accountIndex);
      if (!userDataResult.success) {
        throw new Error(`Failed to get user data: ${userDataResult.error}`);
      }
      const { hero, dbData } = userDataResult.data;

      const result = await this.getAliance(hash, accountIndex);
      if (!result.success) return;
      const alliances = result.data
        .map((item) => {
          // Tìm bonus dựa trên exp
          const matchingLevel = dbData.dbAlliance.reverse().find((item2) => item.exp >= item2.exp);

          // Nếu tìm thấy, thêm bonus vào đối tượng
          return {
            ...item,
            bonus: matchingLevel ? matchingLevel.bonus : 0, // Nếu không tìm thấy, gán bonus là 0
          };
        })
        .sort((a, b) => b.bonus - a.bonus);
      const alliance = findOptimalElement(alliances, hero.coins);
      if (!alliance) return this.log(`No alliance available to join!`, "warning");
      await this.joinAliance(hash, accountIndex, alliance.id);
    } catch (error) {}
  }

  async setQuiz(hash, accountIndex, questKey, result) {
    const url = `${this.baseURL}/quiz/result/set`;
    const currentTime = Math.floor(Date.now() / 1000);
    const payload = {
      data: {
        key: questKey,
        result: result,
      },
    };
    const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));

    const headers = {
      ...this.headers,
      "api-hash": `${apiHash}`,
      "Api-Key": `${hash}`,
      "Api-Time": `${currentTime}`,
    };

    try {
      const response = await axios.post(url, payload, { headers, ...this.getAxiosConfig(accountIndex) });
      if (response.status === 200 && response.data.success) {
        return response.data;
      }
    } catch (error) {
      this.log(`Error while checking quiz "${questKey}": ${error.message}`, "error");
      return { success: false, error: error.message };
    }
  }

  async claimQuiz(hash, accountIndex, questKey) {
    const payload = { data: { key: questKey } };
    const currentTime = Math.floor(Date.now() / 1000);
    const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));
    const url = `${this.baseURL}/quiz/claim`;
    const headers = {
      ...this.headers,
      "api-hash": `${apiHash}`,
      "Api-Key": `${hash}`,
      "Api-Time": `${currentTime}`,
    };

    try {
      const response = await axios.post(url, payload, {
        headers,
        ...this.getAxiosConfig(accountIndex),
      });
      if (response.status === 200 && response.data.success) {
        return { success: true, data: response.data };
      } else {
        return { success: false, error: response.data.error };
      }
    } catch (error) {
      this.log(`Error when claiming quiz "${questKey}": ${error.message}`, "error");
      return { success: false, error: error.message };
    }
  }

  async claimQuest(hash, accountIndex, questKey, checkData = null) {
    const payload = { data: [questKey, checkData] };
    const currentTime = Math.floor(Date.now() / 1000);
    const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));
    const url = `${this.baseURL}/quests/claim`;
    const headers = {
      ...this.headers,
      "api-hash": `${apiHash}`,
      "Api-Key": `${hash}`,
      "Api-Time": `${currentTime}`,
    };

    try {
      const response = await axios.post(url, payload, {
        headers,
        ...this.getAxiosConfig(accountIndex),
      });
      if (response.status === 200 && response.data.success) {
        this.log(`Claim quest "${questKey}" successfully, receive reward.`, "success");
        return { success: true, data: response.data };
      } else {
        return { success: false, error: response.data.error };
      }
    } catch (error) {
      this.log(`Error when claiming task"${questKey}": ${error.message}`, "error");
      return { success: false, error: error.message };
    }
  }

  async completeAllQuests(initData, accountIndex) {
    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }
      const userDataResult = await this.getUserData(initData, accountIndex);
      if (!userDataResult.success) {
        throw new Error(`Failed to get user data: ${userDataResult.error}`);
      }
      const { dbData } = userDataResult.data;
      const quests = dbData.dbQuests.filter((q) => !settings.SKIP_TASKS.includes(q.key) && (q.actionTo == "" || !q.actionTo));

      for (const quest of quests) {
        if (quest.checkType === "donate_ton" || quest.checkType === "invite" || quest.checkType === "username" || quest.checkType === "ton_wallet_transaction") {
          continue;
        }
        if (quest.checkType === "checkCode") {
          await this.AnswerDaily(hash, accountIndex, quest.key, quest.checkData);
          continue;
        }
        const claimResult = await this.claimQuest(hash, accountIndex, quest.key);
        if (claimResult.success === true) {
          this.log(`Complete quest ${quest.key} | "${quest.title}", receive ${quest.reward} reward.`, "success");
} else if (claimResult.error === "already rewarded") {
this.log(`Quest ${quest.key} "${quest.title}" has been completed before.`, "warning");
} else {
this.log(`Quest cannot be completed or needs to be done manually${quest.key} | "${quest.title}": ${claimResult.error}`, "warning");
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      const quizs = dbData.dbQuizzes;
      if (quizs.length <= 0) return;
      let res = await this.setQuiz(hash, accountIndex, quizs[0].key, quizs[0].answers[0].key);
      if (!res.success) return;
      const { quizzes } = res.data;
      const quizsAvaliable = quizs.filter((item1) => {
        const found = quizzes.find((element) => element.key === item1.key);
        // Nếu không tìm thấy trong array2 hoặc found.isReward là false thì giữ lại
        return !found || !found.isRewarded;
      });

      for (const quiz of quizsAvaliable) {
        this.log(`Start quiz ${quiz.title}...`, "info");
        const result = quiz.answers[0].key;
        res = await this.setQuiz(hash, accountIndex, quiz.key, result);
        if (!res.success) continue;
        // const { quizzes } = res.data;
        // if(quizzes)
        // const checkIsReward = quizzes.find((q) => q.key === quiz.key);
        // if (checkIsReward && checkIsReward?.isRewarded) continue;

        const claimResult = await this.claimQuiz(hash, accountIndex, quiz.key);
        if (claimResult.success === true) {
          this.log(`Complete quiz ${quiz.key} | "${quiz.title}", receive ${quiz.reward} reward.`, "success");
} else if (claimResult.error === "already rewarded") {
this.log(`quiz ${quiz.key} "${quiz.title}" has been completed before.`, "warning");
} else {
this.log(`Cannot complete or need to do it manually quiz ${quiz.key} | "${quiz.title}": ${claimResult.error}`, "warning");
}
await new Promise((resolve) => setTimeout(resolve, 1000));
}
} catch (error) {
this.log(`Error while getting quiz list: ${error.message}`, "error");
    }
  }

  async handleAutoFeed(initData, accountIndex) {
    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }

      const userDataResult = await this.getUserData(initData, accountIndex);
      if (!userDataResult.success) {
        throw new Error(`Failed to get user data: ${userDataResult.error}`);
      }

      const { hero, feed } = userDataResult.data;

      if (feed.isNeedFeed) {
        if (!hero.onboarding.includes("20")) {
          const currentTime = Math.floor(Date.now() / 1000);
          const payload = { data: 20 };
          const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));

          const headers = {
            ...this.headers,
            "api-hash": apiHash,
            "Api-Key": hash,
            "Api-Time": currentTime,
          };

          const onboardingResponse = await axios.post(`${this.baseURL}/hero/onboarding/finish`, payload, {
            headers,
            ...this.getAxiosConfig(accountIndex),
          });

          if (!onboardingResponse.data.success) {
            throw new Error("Failed to complete onboarding step 20");
          }
        }

        const currentTime = Math.floor(Date.now() / 1000);
        const feedPayload = { data: "instant" };
        const apiHash = await this.createApiHash(currentTime, JSON.stringify(feedPayload));

        const headers = {
          ...this.headers,
          "api-hash": apiHash,
          "Api-Key": hash,
          "Api-Time": currentTime,
        };

        const feedResponse = await axios.post(`${this.baseURL}/autofeed/buy`, feedPayload, {
          headers,
          ...this.getAxiosConfig(accountIndex),
        });

        if (feedResponse.data.success) {
          this.log("Feeding animals successfully", "success");
          return { success: true, data: feedResponse.data };
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async buyOrUpgradeAnimals(initData, accountIndex) {
    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }

      const userDataResult = await this.getUserData(initData, accountIndex);
      if (!userDataResult.success) {
        throw new Error(`Failed to get user data: ${userDataResult.error}`);
      }

      const { animals, hero, dbData } = userDataResult.data;
      const existingKeys = new Set(animals.map((animal) => animal.key));
      const usedPositions = new Set(animals.map((animal) => animal.position));

      if (settings.AUTO_BUY_ANIMAL) {
        for (const dbAnimal of dbData.dbAnimals) {
          if (!existingKeys.has(dbAnimal.key)) {
            const level1Price = dbAnimal.levels[0].price;

            if (hero.coins >= level1Price) {
              let position = 1;
              while (usedPositions.has(position)) {
                position++;
              }

              const currentTime = Math.floor(Date.now() / 1000);
              const payload = { data: { position, animalKey: dbAnimal.key } };
              const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));

              const headers = {
                ...this.headers,
                "api-hash": apiHash,
                "Api-Key": hash,
                "Api-Time": currentTime,
              };

              const response = await axios.post(`${this.baseURL}/animal/buy`, payload, {
                headers,
                ...this.getAxiosConfig(accountIndex),
              });

              if (response.status === 200 && response.data.success) {
                this.log(`Buy successfully ${dbAnimal.title}`, "success");
                usedPositions.add(position);
                existingKeys.add(dbAnimal.key);
              }
            }
          }
        }
      }
      if (settings.AUTO_UPGRADE_ANIMAL) {
        for (const animal of animals) {
          const dbAnimal = dbData.dbAnimals.find((dba) => dba.key === animal.key);
          if (dbAnimal) {
            if (animal.level >= settings.MAX_LEVEL_UPGRADE_ANIMAL) continue;
            const nextLevel = animal.level + 1;
            const nextLevelData = dbAnimal.levels.find((l) => l.level === nextLevel);

            if (nextLevelData && hero.coins >= nextLevelData.price) {
              const currentTime = Math.floor(Date.now() / 1000);
              const payload = { data: { position: animal.position, animalKey: animal.key } };
              const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));

              const headers = {
                ...this.headers,
                "api-hash": apiHash,
                "Api-Key": hash,
                "Api-Time": currentTime,
              };

              try {
                const response = await axios.post(`${this.baseURL}/animal/buy`, payload, {
                  headers,
                  ...this.getAxiosConfig(accountIndex),
                });

                if (response.status === 200 && response.data.success) {
                  this.log(`${dbAnimal.title} successfully upgraded to level ${nextLevel}`, "success");
                }
              } catch (error) {
                if (error.response?.status === 500) {
                  this.log(`Cannot upgrade ${dbAnimal.title}: ${error.message}`, "error");
                }
              }
            }
          }
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  log(msg, type = "info") {
    const timestamp = new Date().toLocaleTimeString();
    const accountPrefix = `[Account ${this.accountIndex + 1}]`;
    const ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : "[Unknown IP]";

    switch (type) {
      case "success":
        console.log(`[${timestamp}]${accountPrefix}${ipPrefix} [✓] ${msg}`.green);
        break;
      case "custom":
        console.log(`[${timestamp}]${accountPrefix}${ipPrefix} [*] ${msg}`.magenta);
        break;
      case "error":
        console.log(`[${timestamp}]${accountPrefix}${ipPrefix} [✗] ${msg}`.red);
        break;
      case "warning":
        console.log(`[${timestamp}]${accountPrefix}${ipPrefix} [!] ${msg}`.yellow);
        break;
      default:
        console.log(`[${timestamp}]${accountPrefix}${ipPrefix} [ℹ] ${msg}`.blue);
    }
  }

  calculateWaitTimeInSeconds(nextFeedTime) {
    const now = DateTime.local();
    const feedTime = DateTime.fromFormat(nextFeedTime, "yyyy-MM-dd HH:mm:ss", { zone: "UTC" }).setZone("local");
    const diffInSeconds = Math.max(0, Math.floor(feedTime.diff(now, "seconds").seconds));
    return diffInSeconds;
  }

  async countdown(seconds) {
    const endTime = DateTime.local().plus({ seconds });

    for (let i = seconds; i > 0; i--) {
      const currentTime = DateTime.local().toLocaleString(DateTime.TIME_WITH_SECONDS);
      const remainingTime = endTime.diff(DateTime.local());
      const remainingMinutes = Math.floor(remainingTime.as("minutes"));
      const remainingSeconds = Math.floor(remainingTime.as("seconds")) % 60;

      readline.cursorTo(process.stdout, 0);
      process.stdout.write(`[${currentTime}] [*]Wait ${remainingMinutes} minutes ${remainingSeconds} seconds to continue...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
  }

  async runAccount() {
    const i = this.accountIndex;
    try {
      const initData = this.queryId;
      const queryData = JSON.parse(decodeURIComponent(initData.split("user=")[1].split("&")[0]));
      const firstName = queryData.first_name || "";
      const lastName = queryData.last_name || "";
      this.session_name = queryData.id;

      if (this.proxy) {
        try {
          this.proxyIP = await this.checkProxyIP(this.proxy);
        } catch (proxyError) {
          this.log(`Proxy check failed: ${proxyError.message}`, "warning");
        }
      }
      const timesleep = getRandomNumber(settings.DELAY_START_BOT[0], settings.DELAY_START_BOT[1]);
      console.log(`=========Account ${i + 1}| ${firstName + " " + lastName} | ${this.proxyIP} | Starts in ${timesleep} seconds...`.green);
      this.set_headers();
      await sleep(timesleep);

      this.log(`Logging in...`, "info");
const loginResult = await this.login(initData, i);
if (loginResult.success) {
this.log("Login successful!", "success");

        const userDataResult = await this.getUserData(initData, i);
        if (userDataResult.success) {
          const { hero, feed, alliance, profile } = userDataResult.data;
          this.log(`User: ${(profile.firstName || "") + (profile.lastName || "")} | Coins: ${hero.tokens} | Food: ${hero.coins}`);

          if (Array.isArray(hero.onboarding) && hero.onboarding.length === 0) {
            this.log("Completing onboarding...", "info");
const onboardingResult = await this.finishOnboarding(initData, i);
if (onboardingResult.success) {
this.log("Completed onboarding successfully!", "success");
            }
          }

          if (!alliance?.id || alliance?.length == 0) {
            await this.handleAliance(initData, i);
          }

          if (settings.AUTO_FEED) {
            await sleep(1);
            await this.handleAutoFeed(initData, i);
          }
          await sleep(1);
          await this.completeAllQuests(initData, i);
          await sleep(1);

          if (settings.AUTO_BUY_ANIMAL || settings.AUTO_UPGRADE_ANIMAL) {
            await this.buyOrUpgradeAnimals(initData, i);
          }

          const dataAfterResult = await this.getUserDataAfter(initData, i);
          if (dataAfterResult.success) {
            const { dailyRewards } = dataAfterResult.data;
            for (let day = 1; day <= 16; day++) {
              if (dailyRewards[day] === "canTake") {
                this.log(`Claiming daily reward ${day}...`, "info");
const claimResult = await this.claimDailyReward(initData, day, i);
if (claimResult.success) {
this.log("Daily check-in successful!", "success");
                }
                break;
              }
            }
          }

          const finalData = await this.getUserData(initData, i);
          if (finalData.success) {
            this.log(`Coins: ${finalData.data.hero.tokens} | Food: ${finalData.data.hero.coins}`, "custom");
          }
        }
      } else {
        this.log(`Login failed: ${loginResult.error}`, "warning");
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      this.log(`Error processing account ${i + 1}: ${error.message}`, "error");
      return;
    }
  }
}

async function runWorker(workerData) {
  const { queryId, accountIndex, proxy, hasIDAPI } = workerData;
  const to = new ZooAPIClient(queryId, accountIndex, proxy, hasIDAPI);
  try {
    await Promise.race([to.runAccount(), new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 24 * 60 * 60 * 1000))]);
    parentPort.postMessage({
      accountIndex,
    });
  } catch (error) {
    parentPort.postMessage({ accountIndex, error: error.message });
  } finally {
    if (!isMainThread) {
      parentPort.postMessage("taskComplete");
    }
  }
}

async function main() {
  const queryIds = loadData("data.txt");
  const proxies = loadData("proxy.txt");

  if (queryIds.length > proxies.length) {
    console.log("The number of proxies and data must be equal..".red);
    console.log(`Data: ${queryIds.length}`);
    console.log(`Proxy: ${proxies.length}`);
    process.exit(1);
  }
  console.log("Script by (https://t.me/D4rkCipherX)".yellow);
  let maxThreads = settings.MAX_THEADS;

  const { endpoint: hasIDAPI, message } = await checkBaseUrl();
  if (!hasIDAPI) return console.log(`API ID not found, try again later!`.red);
  console.log(`${message}`.yellow);
  // process.exit();
  queryIds.map((val, i) => new ZooAPIClient(val, i, proxies[i], hasIDAPI).createUserAgent());

  await sleep(1);
  while (true) {
    let currentIndex = 0;
    const errors = [];

    while (currentIndex < queryIds.length) {
      const workerPromises = [];
      const batchSize = Math.min(maxThreads, queryIds.length - currentIndex);
      for (let i = 0; i < batchSize; i++) {
        const worker = new Worker(__filename, {
          workerData: {
            hasIDAPI,
            queryId: queryIds[currentIndex],
            accountIndex: currentIndex,
            proxy: proxies[currentIndex % proxies.length],
          },
        });

        workerPromises.push(
          new Promise((resolve) => {
            worker.on("message", (message) => {
              if (message === "taskComplete") {
                worker.terminate();
              }
              if (settings.ENABLE_DEBUG) {
                console.log(message);
              }
              resolve();
            });
            worker.on("error", (error) => {
              console.log(`Worker error for account ${currentIndex}: ${error.message}`);
worker.terminate();
resolve();
});
worker.on("exit", (code) => {
worker.terminate();
if (code !== 0) {
errors.push(`Worker for account ${currentIndex} exited with code: ${code}`);
              }
              resolve();
            });
          })
        );

        currentIndex++;
      }

      await Promise.all(workerPromises);

      if (errors.length > 0) {
        errors.length = 0;
      }

      if (currentIndex < queryIds.length) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    await sleep(3);
    console.log("Join (https://t.me/D4rkCipherX)".yellow);
    console.log(`=============Complete all accounts | Wait ${settings.TIME_SLEEP} minutes=============`.magenta);
    await sleep(settings.TIME_SLEEP * 60);
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.log("It's a mistake:", error);
    process.exit(1);
  });
} else {
  runWorker(workerData);
}
