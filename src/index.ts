import dotenv from 'dotenv';
dotenv.config();
import express, { Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { chromium } from 'playwright';
import fs from 'fs';
import { messages, URL_REGEX, DETAILS_CHAT_ID, IDS_PATH, IDS_FILENAME, urls, BROWSER_OPTIONS, ELEMENT_SELECTOR_1, ELEMENT_SELECTOR_2 } from './config';
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
  tracesSampleRate: 0.1,
});

app.use(Sentry.Handlers.requestHandler());

app.use(Sentry.Handlers.tracingHandler());

const bot = new TelegramBot(API_KEY, {polling: true});

const PORT = process.env.PORT || 5000;

app.use('/files', express.static('files'));

app.get('/api/check/:id?', async (req: Request, res: Response) => {
  const { id } = req.params;
  const url = urls[Number(id)] || urls[0];
  check(url);
  res.json({message: 'checked'});
});

app.get('/api/details/:id?', async (req: Request, res: Response) => {
  const { id } = req.params;
  const url = urls[Number(id)] || urls[0];
  checkForDetails(url);
  res.json({message: 'details'});
});

app.get('/api/issubscribed', async (req: Request, res: Response) => {
  isSubscribedAll();
  res.json({message: 'issubscribed'});
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
  let redirectedUrl = '';
  const browser = await chromium.launch(BROWSER_OPTIONS);
  const page = await browser.newPage();
  await page.goto(url, {waitUntil: 'domcontentloaded'});

  try {
    await page.waitForURL(URL_REGEX, {waitUntil: 'domcontentloaded', timeout: 7000});
    redirected = true;
    redirectedUrl = page.url();
  } catch (error: any) {
    // console.log('error', error);
    // the page was not redirected in the timeout or another error ocurred
    // asume that the page is not redirecting
  }

  const elementExists1 = await page.locator(ELEMENT_SELECTOR_1).count() > 0;
  const elementExists2 = await page.locator(ELEMENT_SELECTOR_2).count() > 0;
  
  try {
    await page.screenshot({ path: 'files/screenshot.jpg', fullPage: true, quality: 60, type: 'jpeg' });
    if(redirected) await saveFile(`${messages.redirectedUrl}\n\n${redirectedUrl}`, 'files', 'redirectedurl.txt');
    if(elementExists1 || elementExists2 || redirected) {
      await page.screenshot({ path: 'files/available.jpg', fullPage: true, quality: 60, type: 'jpeg' });
    }
  } catch (error: any) {
    Sentry.captureException(error);
  }

  await page.close();
  await browser.close();
  
  return {
    elementExists1,
    elementExists2,
    redirected,
    redirectedUrl,
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
      sendToDetails(`${messages.subscribed}: ${msg.chat.first_name} ${msg.chat.last_name || ''}`);
    }
  } catch (error) {
    Sentry.captureException(error);
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
      sendToDetails(`${messages.unsubscribed}: ${msg.chat.first_name} ${msg.chat.last_name || ''}`);
    }
  } catch (error) {
    Sentry.captureException(error);
  }
});

bot.onText(/\/screenshot/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const filepath = 'files/screenshot.jpg';
    if(!fs.existsSync(filepath)) throw new Error('Screenshot doesn\'t exist');
    bot.sendPhoto(chatId, filepath);
  } catch (error: any) {
    Sentry.captureException(error);
    bot.sendMessage(chatId, error.message);
  }
});

bot.onText(/\/available/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const filepath = 'files/available.jpg';
    if(!fs.existsSync(filepath)) throw new Error('Available screenshot doesn\'t exist');
    await bot.sendPhoto(chatId, filepath);
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
    let detailMessage = getDetailsMessage(check.elementExists1, check.elementExists2, check.redirected, check.redirectedUrl);
    if(check.elementExists1 || check.elementExists2 || check.redirected) {
      detailMessage += `\n\n${messages.notification}`;
    }
    detailMessage += `\n\n${url}`;
    sendToDetails(detailMessage);
  } catch (error: any) {
    Sentry.captureException(error);
    sendToDetails(error.message);
  }
};

const check = async (url: string) => {
  try {
    const check = await checkPage(url);
    if(check.elementExists1 || check.elementExists2 || check.redirected) {
      const ids = await getIds();
      sendTo(ids, `${messages.notification}\n\n${url}`);
    }
  } catch (error) {
    Sentry.captureException(error);
  }
};

const getDetailsMessage = (elementExists1: boolean, elementExists2: boolean, redirected: boolean, redirectedUrl: string) => {
  return `${messages.elementExists1}${elementExists1}\n${messages.elementExists2}${elementExists2}\n${messages.redirected}${redirected}\n${messages.redirectedUrl}${redirectedUrl || '[empty]'}`;
};

const sendTo = async (ids: number[], message: string) => {
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    bot.sendMessage(id, message);
  }
};

const sendToDetails = async (message: string) => {
  bot.sendMessage(DETAILS_CHAT_ID, message);
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
