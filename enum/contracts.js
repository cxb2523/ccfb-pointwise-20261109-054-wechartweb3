const UtilsAddresses = require("../utils/addresses");
const EnumChainId = require("./chain.id");

const EnumContracts = {
    [EnumChainId.BSC]: {
        MAIN_ROUTER: UtilsAddresses.toCheckSum("0x10ED43C718714eb63d5aA57B78B54704E256024E"), // Pancake
        MAIN_FACTORY: UtilsAddresses.toCheckSum("0xca143ce32fe78f1f7019d7d551a6402fc5350c73") // Pancake
    },
    [EnumChainId.POLYGON_AMOY]: {
        MAIN_ROUTER: UtilsAddresses.toCheckSum("0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"), // Uniswap V2 (Amoy testnet)
        MAIN_FACTORY: UtilsAddresses.toCheckSum("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f") // Uniswap V2 (Amoy testnet)
    }
};

module.exports = EnumContracts