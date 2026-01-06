import { useState } from 'react'
import { ethers } from 'ethers'
import './App.css'

const OPENSEA_API_KEY = ''
const API_BASE = '/opensea/api/v2'

const APECHAIN = {
  slug: 'ape_chain',
  chainId: '0x8173',
  name: 'ApeChain',
  rpc: 'https://rpc.apechain.com/http',
  nativeCurrency: { name: 'APE', symbol: 'APE', decimals: 18 },
  blockExplorer: 'https://apescan.io',
}

function App() {
  const [wallet, setWallet] = useState(null)
  const [provider, setProvider] = useState(null)
  const [contractAddress, setContractAddress] = useState('')
  const [tokenId, setTokenId] = useState('')
  const [nft, setNft] = useState(null)
  const [listing, setListing] = useState(null)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  const apiCall = async (endpoint) => {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { 'X-API-KEY': OPENSEA_API_KEY, 'Accept': 'application/json' }
    })
    if (!res.ok) throw new Error(`API error: ${res.status}`)
    return res.json()
  }

  const switchToApeChain = async () => {
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: APECHAIN.chainId }],
      })
    } catch (e) {
      if (e.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: APECHAIN.chainId,
            chainName: APECHAIN.name,
            rpcUrls: [APECHAIN.rpc],
            nativeCurrency: APECHAIN.nativeCurrency,
            blockExplorerUrls: [APECHAIN.blockExplorer],
          }],
        })
      }
    }
  }

  const connectWallet = async () => {
    try {
      setError('')
      if (!window.ethereum) { setError('Install MetaMask!'); return }
      await switchToApeChain()
      const p = new ethers.providers.Web3Provider(window.ethereum)
      await p.send('eth_requestAccounts', [])
      const address = await p.getSigner().getAddress()
      setWallet(address)
      setProvider(p)
      setStatus('Connected on ApeChain')
    } catch (err) { setError(err.message) }
  }

  const fetchNFT = async () => {
    if (!contractAddress || !tokenId) { setError('Enter contract + token ID'); return }
    try {
      setLoading(true); setError(''); setNft(null); setListing(null)

      const asset = await apiCall(`/chain/${APECHAIN.slug}/contract/${contractAddress}/nfts/${tokenId}`)
      setNft(asset.nft)

      const listingsRes = await apiCall(`/listings/collection/${asset.nft.collection}/nfts/${tokenId}/best`)
      if (listingsRes.order_hash) {
        setListing(listingsRes)
        setStatus('NFT found with listing!')
      } else {
        setStatus('NFT found - no active listing')
      }
    } catch (err) {
      console.error(err)
      setError('Error: ' + err.message)
    }
    finally { setLoading(false) }
  }

  const buyNFT = async () => {
    if (!listing || !wallet || !provider) { setError('No listing available'); return }
    try {
      setLoading(true); setError(''); setStatus('Checking balance...')

      const balance = await provider.getBalance(wallet)
      const price = ethers.BigNumber.from(listing.price?.current?.value || '0')
      const gasBuffer = ethers.utils.parseEther('0.1')
      const totalNeeded = price.add(gasBuffer)
      const balanceFormatted = ethers.utils.formatEther(balance)
      const priceFormatted = ethers.utils.formatEther(price)

      if (balance.lt(totalNeeded)) {
        setError(`Insufficient balance! You have ${parseFloat(balanceFormatted).toFixed(4)} APE but need ~${parseFloat(priceFormatted).toFixed(4)} APE + gas`)
        setLoading(false)
        return
      }

      setStatus('Preparing purchase...')
      const fulfillRes = await fetch(`${API_BASE}/listings/fulfillment_data`, {
        method: 'POST',
        headers: {
          'X-API-KEY': OPENSEA_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          listing: { hash: listing.order_hash, chain: APECHAIN.slug, protocol_address: listing.protocol_address },
          fulfiller: { address: wallet },
        })
      })

      if (!fulfillRes.ok) {
        const errText = await fulfillRes.text()
        console.error('Fulfillment error:', errText)
        throw new Error('Failed to get fulfillment data: ' + fulfillRes.status)
      }
      const data = await fulfillRes.json()
      const fulfillment_data = data.fulfillment_data

      if (!fulfillment_data?.transaction) {
        throw new Error('No transaction data returned')
      }

      setStatus('Confirm in MetaMask...')
      const signer = provider.getSigner()
      const txData = fulfillment_data.transaction
      const inputData = txData.input_data

      const seaportAbi = [
        'function fulfillAdvancedOrder(tuple(tuple(address offerer, address zone, tuple(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, tuple(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) parameters, uint120 numerator, uint120 denominator, bytes signature, bytes extraData) advancedOrder, tuple(uint256 orderIndex, uint8 side, uint256 index, uint256 identifier, bytes32[] criteriaProof)[] criteriaResolvers, bytes32 fulfillerConduitKey, address recipient) payable returns (bool fulfilled)'
      ]

      const seaportInterface = new ethers.utils.Interface(seaportAbi)
      const calldata = seaportInterface.encodeFunctionData('fulfillAdvancedOrder', [
        inputData.advancedOrder,
        inputData.criteriaResolvers,
        inputData.fulfillerConduitKey,
        inputData.recipient
      ])

      const tx = await signer.sendTransaction({
        to: txData.to,
        data: calldata,
        value: txData.value,
        gasLimit: 350000,
      })

      setStatus('TX sent! ' + tx.hash)
      await tx.wait()
      setStatus('Purchase complete! ' + tx.hash)
    } catch (err) {
      console.error(err)
      if (err.message?.includes('InsufficientNativeTokensSupplied') || err.message?.includes('a61be9f0')) {
        setError('Insufficient APE balance for this purchase')
      } else {
        setError('Failed: ' + err.message)
      }
    }
    finally { setLoading(false) }
  }

  return (
    <div className="app">
      <h1>ApeChain NFT Buyer</h1>
      <div className="section">
        {!wallet ? <button onClick={connectWallet}>Connect Wallet</button>
          : <p className="wallet">Connected: {wallet.slice(0,6)}...{wallet.slice(-4)}</p>}
      </div>
      <div className="section">
        <h2>Find NFT</h2>
        <input placeholder="Contract Address" value={contractAddress} onChange={e => setContractAddress(e.target.value)} />
        <input placeholder="Token ID" value={tokenId} onChange={e => setTokenId(e.target.value)} />
        <button onClick={fetchNFT} disabled={loading || !wallet}>{loading ? 'Loading...' : 'Search'}</button>
      </div>
      {nft && (
        <div className="section nft-card">
          <h2>{nft.name || '#' + nft.identifier}</h2>
          {nft.image_url && <img src={nft.image_url} alt={nft.name} className="nft-image" />}
          <p>Collection: {nft.collection}</p>
          <p>Token: {nft.identifier}</p>
          {listing && (
            <div className="listing-info">
              <p className="price">
                {ethers.utils.formatEther(listing.price?.current?.value || '0')} APE
              </p>
              <button onClick={buyNFT} disabled={loading} className="buy-button">
                {loading ? 'Processing...' : 'Buy Now'}
              </button>
            </div>
          )}
        </div>
      )}
      {status && <p className="status">{status}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

export default App
