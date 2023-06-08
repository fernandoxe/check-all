import express, { Request, Response } from 'express';
import { chromium } from 'playwright';
import fs from 'fs';
import { PAGE, elementSelector } from './config';

const app = express();

const PORT = process.env.PORT || 5000;

app.get('/', async (req: Request, res: Response) => {
  try {
    const check = await checkPage(PAGE);
    res.send({elementExists: check});
  } catch (error: any) {
    res.status(500).send({error: error.message});
  }
});

app.get('/email', async (req: Request, res: Response) => {
  try {
    res.send({email: 'sended'});
  } catch (error: any) {
    res.status(500).send({error: error.message});
  }
});

app.listen(PORT, () => {
  console.log('Server is listening on port 3000');
});

const checkPage = async (url: string) => {
  const browser = await chromium.launch({ headless: false});
  const page = await browser.newPage();
  await page.goto(url, {waitUntil: 'domcontentloaded'});
  await page.screenshot({ path: 'files/screenshot.jpg', fullPage: true });
  const htmlConfirmCode = await page.content();
  await saveFile(htmlConfirmCode, 'files', 'index.html');
  const elementExists = await page.locator(elementSelector).count() > 0;

  await page.close();
  await browser.close();

  return elementExists;
};

const saveFile = async (data: any, path: string, filename: string) => {
  if(!fs.existsSync(path)) fs.mkdirSync(path, {recursive: true});
  await fs.promises.writeFile(`${path}/${filename}`, data);
};