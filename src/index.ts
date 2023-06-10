import dotenv from 'dotenv';
dotenv.config();
import express, { Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { chromium } from 'playwright';
import fs from 'fs';
import { ELEMENT_SELECTOR, messages, URL_REGEX, DETAILS_CHAT_ID, IDS_PATH, IDS_FILENAME, urls, BROWSER_OPTIONS } from './config';
import TelegramBot from 'node-telegram-bot-api';

const app = express();

const API_KEY = process.env.API_KEY || '';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [
    // enable HTTP calls tracing
    new Sentry.Integrations.Http({ tracing: true }),
    // enable Express.js middleware tracing
    new Sentry.Integrations.Express({ app }),
    // Automatically instrument Node.js libraries and frameworks
    ...Sentry.autoDiscoverNodePerformanceMonitoringIntegrations(),
  ],

  // Set tracesSampleRate to 1.0 to capture 100%
  // of transactions for performance monitoring.
  // We recommend adjusting this value in production
  tracesSampleRate: 1.0,
});

app.use(Sentry.Handlers.requestHandler());

app.use(Sentry.Handlers.tracingHandler());

const bot = new TelegramBot(API_KEY, {polling: true});

const PORT = process.env.PORT || 5000;

app.use('/files', express.static('files'));

app.get('/api/check/:id?', async (req: Request, res: Response) => {
  const { id } = req.params;
  const url = urls[Number(id)] || urls[0];
  try {
    check(url);
    res.send({message: 'checked'});
  } catch (error: any) {
    Sentry.captureException(error);
    res.status(500).send({error: error.message});
  }
});

app.get('/api/details/:id?', async (req: Request, res: Response) => {
  const { id } = req.params;
  const url = urls[Number(id)] || urls[0];
  try {
    checkForDetails(url);
    res.send({message: 'details'});
  } catch (error: any) {
    Sentry.captureException(error);
    bot.sendMessage(DETAILS_CHAT_ID, error.message);
    res.status(500).send({error: error.message});
  }
});

app.get('/api/issubscribed', async (req: Request, res: Response) => {
  try {
    isSubscribedAll();
    res.send({message: 'issubscribed'});
  } catch (error: any) {
    Sentry.captureException(error);
    res.status(500).send({error: error.message});
  }
});

app.get('*', (req: Request, res: Response) => {
  res.status(404).json({message: 'Not found'});
});

app.use(Sentry.Handlers.errorHandler());

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

const checkPage = async (url: string) => {
  let redirected = false;
  const browser = await chromium.launch(BROWSER_OPTIONS);
  const page = await browser.newPage();
  await page.goto(url, {waitUntil: 'domcontentloaded'});

  try {
    await page.waitForURL(URL_REGEX, {waitUntil: 'domcontentloaded', timeout: 7000});
    redirected = true;
  } catch (error: any) {
    // the page was not redirected in the timeout or another error ocurred
    // asume that the page is not redirecting
  }

  const elementExists = await page.locator(ELEMENT_SELECTOR).count() > 0;
  
  await page.screenshot({ path: 'files/screenshot.jpg', fullPage: true, quality: 40, type: 'jpeg' });
  const htmlConfirmCode = await page.content();
  await saveFile(htmlConfirmCode, 'files', 'index.html');

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
    Sentry.captureException(error);
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
    Sentry.captureException(error);
    bot.sendMessage(chatId, messages.retryUnsubscribe);
  }
});

bot.onText(/\/details/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    checkForDetails(urls[0]);
  } catch (error: any) {
    Sentry.captureException(error);
    bot.sendMessage(chatId, error.message);
  }
});

const isSubscribedAll = async () => {
  try {
    const ids = await getIds();
    sendTo(ids, messages.isSubscribed);
  } catch (error) {
    Sentry.captureException(error);
  }
};

const checkForDetails = async (url: string) => {
  try {
    const check = await checkPage(url);
    sendDetails(DETAILS_CHAT_ID, check.elementExists, check.redirected);
  } catch (error) {
    Sentry.captureException(error);
  }
};

const check = async (url: string) => {
  try {
    const check = await checkPage(url);
    if(check.elementExists || check.redirected) {
      const ids = await getIds();
      sendTo(ids, `${messages.notification}${url}`);
    }
  } catch (error) {
    Sentry.captureException(error);
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
    Sentry.captureException(error);
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
