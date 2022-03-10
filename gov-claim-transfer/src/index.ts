import {
  FlashbotsBundleProvider,
  FlashbotsBundleRawTransaction,
  FlashbotsBundleResolution,
  FlashbotsBundleTransaction,
} from "@flashbots/ethers-provider-bundle";
import { BigNumber, providers, Wallet } from "ethers";
import { Base } from "./engine/Base";
import { checkSimulation, gasPriceToGwei, printTransactions } from "./utils";
import { hexlify, toUtf8Bytes } from "ethers/lib/utils";
import { UnstakeAndTransferERC20 } from "./engine/UnstakeAndTransferERC20";
import { config } from "dotenv";
config();

require("log-timestamp");

const BLOCKS_IN_FUTURE = 2;

const GWEI = BigNumber.from(10).pow(9);
const PRIORITY_GAS_PRICE = GWEI.mul(50);

const PRIVATE_KEY_EXECUTOR = process.env.PRIVATE_KEY_EXECUTOR || "";
const PRIVATE_KEY_SPONSOR = process.env.PRIVATE_KEY_SPONSOR || "";
const FLASHBOTS_RELAY_SIGNING_KEY =
  process.env.FLASHBOTS_RELAY_SIGNING_KEY || "";
const RECIPIENT = process.env.RECIPIENT || "";

const DRY_RUN = process.env.DRY_RUN ?? false;

if (PRIVATE_KEY_EXECUTOR === "") {
  console.warn(
    "Must provide PRIVATE_KEY_EXECUTOR environment variable, corresponding to Ethereum EOA with assets to be transferred"
  );
  process.exit(1);
}
if (PRIVATE_KEY_SPONSOR === "") {
  console.warn(
    "Must provide PRIVATE_KEY_SPONSOR environment variable, corresponding to an Ethereum EOA with ETH to pay miner"
  );
  process.exit(1);
}
if (FLASHBOTS_RELAY_SIGNING_KEY === "") {
  console.warn(
    "Must provide FLASHBOTS_RELAY_SIGNING_KEY environment variable. Please see https://github.com/flashbots/pm/blob/main/guides/flashbots-alpha.md"
  );
  process.exit(1);
}
if (RECIPIENT === "") {
  console.warn(
    "Must provide RECIPIENT environment variable, an address which will receive assets"
  );
  process.exit(1);
}

async function main() {
  if (DRY_RUN) console.log(`** DRY RUN **`);

  const walletRelay = new Wallet(FLASHBOTS_RELAY_SIGNING_KEY);
  const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL;
  const provider = new providers.StaticJsonRpcProvider(ETHEREUM_RPC_URL);
  const flashbotsProvider = await FlashbotsBundleProvider.create(
    provider,
    walletRelay
  );

  const walletExecutor = new Wallet(PRIVATE_KEY_EXECUTOR);
  const walletSponsor = new Wallet(PRIVATE_KEY_SPONSOR);

  const block = await provider.getBlock("latest");

  const standardStakedBalance = "411512006350549345171"; //balance in staking
  const standardFutureBalanace = "501516341581107112699"; //expected balance after claims

  const engine: Base = new UnstakeAndTransferERC20(
    provider,
    RECIPIENT,
    standardStakedBalance,
    standardFutureBalanace
  );

  let sponsoredTransactions = await engine.getSponsoredTransactions();

  let gasEstimates = await Promise.all(
    sponsoredTransactions.slice(0, -1).map((tx) =>
      provider.estimateGas({
        ...tx,
        from: tx.from === undefined ? walletExecutor.address : tx.from,
      })
    )
  );

  gasEstimates[gasEstimates.length] = BigNumber.from(100000);

  const gasEstimateTotal = gasEstimates.reduce(
    (acc, cur) => acc.add(cur),
    BigNumber.from(0)
  );

  const gasPrice = PRIORITY_GAS_PRICE.add(block.baseFeePerGas || 0);

  const bundleTransactions: Array<
    FlashbotsBundleTransaction | FlashbotsBundleRawTransaction
  > = [
    {
      transaction: {
        to: walletExecutor.address,
        gasPrice: gasPrice,
        value: gasEstimateTotal.mul(gasPrice),
        gasLimit: 21000,
      },
      signer: walletSponsor,
    },
    ...sponsoredTransactions.map((transaction, txNumber) => {
      return {
        transaction: {
          ...transaction,
          gasPrice: gasPrice,
          gasLimit: gasEstimates[txNumber],
        },
        signer: walletExecutor,
      };
    }),
  ];
  const signedBundle = await flashbotsProvider.signBundle(bundleTransactions);
  await printTransactions(bundleTransactions, signedBundle);
  const simulatedGasPrice = await checkSimulation(
    flashbotsProvider,
    signedBundle
  );

  console.log(await engine.description());

  console.log(`Executor Account: ${walletExecutor.address}`);
  console.log(`Sponsor Account: ${walletSponsor.address}`);
  console.log(`Simulated Gas Price: ${gasPriceToGwei(simulatedGasPrice)} gwei`);
  console.log(`Gas Price: ${gasPriceToGwei(gasPrice)} gwei`);
  console.log(`Gas Used By Executor: ${gasEstimateTotal.toString()}`);
  console.log(
    `Gas Value Used By Executor: ${gasEstimateTotal.mul(gasPrice).toString()}`
  );
  console.log(
    `Gas Value Total: ${gasPrice
      .add(gasEstimateTotal.mul(gasPrice))
      .toString()}`
  );

  if (DRY_RUN) {
    console.log(`** DRY RUN ENDED **`);
    process.exit(0);
  }

  provider.on("block", async (blockNumber) => {
    const simulatedGasPrice = await checkSimulation(
      flashbotsProvider,
      signedBundle
    );
    const targetBlockNumber = blockNumber + BLOCKS_IN_FUTURE;
    console.log(
      `Current Block Number: ${blockNumber},   Target Block Number:${targetBlockNumber},   gasPrice: ${gasPriceToGwei(
        simulatedGasPrice
      )} gwei`
    );
    const bundleResponse = await flashbotsProvider.sendBundle(
      bundleTransactions,
      targetBlockNumber
    );
    if ("error" in bundleResponse) {
      throw new Error(bundleResponse.error.message);
    }
    const bundleResolution = await bundleResponse.wait();
    if (bundleResolution === FlashbotsBundleResolution.BundleIncluded) {
      console.log(`Congrats, included in ${targetBlockNumber}`);
      process.exit(0);
    } else if (
      bundleResolution === FlashbotsBundleResolution.BlockPassedWithoutInclusion
    ) {
      console.log(`Not included in ${targetBlockNumber}`);
    } else if (
      bundleResolution === FlashbotsBundleResolution.AccountNonceTooHigh
    ) {
      console.log("Nonce too high, bailing");
      process.exit(1);
    }
  });
}

main();
