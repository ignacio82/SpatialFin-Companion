// QR paper — renders a real QR fetched from /api/admin/qr (server uses the qrcode library).
// The endpoint returns { dataUrl, payload }.
export default function QrPaper({ dataUrl }) {
  return (
    <div className="qr-paper">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt="Pairing QR"
          style={{ width: '100%', height: '100%', display: 'block', borderRadius: 6 }}
        />
      ) : (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'grid',
            placeItems: 'center',
            color: '#04070d',
            fontSize: 11,
            fontWeight: 600,
            background: '#f4f9fb',
            borderRadius: 6,
          }}
        >
          Loading QR…
        </div>
      )}
      <div className="qr-corners">
        <span/><span/><span/><span/>
      </div>
    </div>
  );
}
