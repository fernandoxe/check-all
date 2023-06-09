import express, { Request, Response } from 'express';
import { chromium } from 'playwright';
import fs from 'fs';
import { PAGE, ELEMENT_SELECTOR, API_KEY, messages, URL_REGEX, DETAILS_CHAT_ID, IDS_PATH, IDS_FILENAME } from './config';
import TelegramBot from 'node-telegram-bot-api';

const app = express();

const bot = new TelegramBot(API_KEY, {polling: true});

const PORT = process.env.PORT || 5000;

app.use('/files', express.static('files'));

app.get('/api/check', async (req: Request, res: Response) => {
  try {
    checkForAll(PAGE);
    res.send({message: 'checked'});
  } catch (error: any) {
    res.status(500).send({error: error.message});
  }
});

app.get('/api/notify', async (req: Request, res: Response) => {
  try {
    check([DETAILS_CHAT_ID], PAGE);
    res.send({message: 'notified'});
  } catch (error: any) {
    res.status(500).send({error: error.message});
    bot.sendMessage(DETAILS_CHAT_ID, error.message);
  }
});

app.get('/api/issubscribed', async (req: Request, res: Response) => {
  try {
    isSubscribedAll();
    res.send({message: 'issubscribed'});
  } catch (error: any) {
    res.status(500).send({error: error.message});
  }
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

const checkPage = async (url: string) => {
  let redirected = false;
  const browser = await chromium.launch({ headless: false});
  const page = await browser.newPage();
  await page.goto(url, {waitUntil: 'domcontentloaded'});

  try {
    await page.waitForURL(URL_REGEX, {waitUntil: 'domcontentloaded', timeout: 5000});
    redirected = true;
  } catch (error: any) {
    // the page was not redirected in the timeout or another error ocurred
    // asume that the page is not redirecting
  }

  await page.screenshot({ path: 'files/screenshot.jpg', fullPage: true });
  const htmlConfirmCode = await page.content();
  await saveFile(htmlConfirmCode, 'files', 'index2.html');

  const elementExists = await page.locator(ELEMENT_SELECTOR).count() > 0;

  await page.close();
  await browser.close();
  
  return {
    elementExists,
    redirected,
  };
};

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, messages.start);
});

bot.onText(/\/subscribe/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const ids = await getIds();
    if(ids.includes(chatId)) {
      bot.sendMessage(chatId, messages.alreadySubscribed);
    } else {
      await addId(chatId, ids);
      bot.sendMessage(chatId, messages.subscribed);
    }
  } catch (error) {
    bot.sendMessage(chatId, messages.retrySubscribe);
  }
});

bot.onText(/\/unsubscribe/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const ids = await getIds();
    if(!ids.includes(chatId)) {
      bot.sendMessage(chatId, messages.alreadyUnsubscribed);
    } else {
      await removeId(chatId, ids);
      bot.sendMessage(chatId, messages.unsubscribed);
    }
  } catch (error) {
    bot.sendMessage(chatId, messages.retryUnsubscribe);
  }
});

bot.onText(/\/details/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const check = await checkPage(PAGE);
    sendDetails(chatId, check.elementExists, check.redirected);
  } catch (error: any) {
    bot.sendMessage(chatId, error.message);
  }
});

const isSubscribedAll = async () => {
  try {
    const ids = await getIds();
    sendTo(ids, messages.isSubscribed);
  } catch (error) {

  }
};

const checkForAll = async (page: string) => {
  try {
    const ids = await getIds();
    check(ids, page);
  } catch (error) {

  }
};

const check = async (ids: number[], page: string) => {
  try {
    const check = await checkPage(page);
    if(check.elementExists || check.redirected) {
      sendTo(ids, messages.notification);
      sendDetails(DETAILS_CHAT_ID, check.elementExists, check.redirected);
    }
  } catch (error) {
    
  }
};

const sendDetails = async (chatId: number, elementExists: boolean, redirected: boolean) => {
  try {
    bot.sendMessage(
      chatId,
      `
${messages.elementExists} ${elementExists}
${messages.redirected} ${redirected}
      `
   );
  } catch (error: any) {
    bot.sendMessage(chatId, error.message)
  }
};

const sendTo = async (ids: number[], message: string) => {
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    bot.sendMessage(id, message);
  }
};

const getIds = async () => {
  const filepath = `${IDS_PATH}/${IDS_FILENAME}`;
  let file = '[]';
  if(fs.existsSync(filepath)) file = fs.readFileSync(filepath, 'utf-8');
  const ids = JSON.parse(file);
  return ids;
}

const addId = async (id: number, ids: number[]) => {
  await saveFile(JSON.stringify([...ids, id], null, 2), IDS_PATH, IDS_FILENAME);
};

const removeId = async (id: number, ids: number[]) => {
  const newIds = ids.filter((i: number) => i !== id);
  await saveFile(JSON.stringify(newIds, null, 2), IDS_PATH, IDS_FILENAME);
};

const saveFile = async (data: any, path: string, filename: string) => {
  if(!fs.existsSync(path)) fs.mkdirSync(path, {recursive: true});
  await fs.promises.writeFile(`${path}/${filename}`, data);
};