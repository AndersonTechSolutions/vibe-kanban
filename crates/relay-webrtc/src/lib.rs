pub mod client;
pub mod error;
pub mod fragment;
pub mod host;
pub mod peer;
pub mod proxy;
pub mod signaling;

pub use client::{WebRtcClient, WebRtcClientError, WsConnection, WsOpenResult};
pub use error::WebRtcError;
pub use host::WebRtcHost;
pub use proxy::{
    DataChannelMessage, DataChannelRequest, DataChannelResponse, DataChannelWsStream, WsClose,
    WsError, WsFrame, WsOpen, WsOpened,
};
pub use signaling::{IceCandidate, SdpAnswer, SdpOffer};

/// Build a webrtc API restricted to UDP4 (IPv4 only).
///
/// Without the UDP4 restriction, the ICE agent tries IPv6 STUN which times
/// out on most networks and blocks ICE gathering.
///
/// `MulticastDnsMode::Disabled` is critical, not cosmetic. mDNS in WebRTC
/// is the "<uuid>.local" host-candidate mechanism browsers use to hide LAN
/// IPs. Both ends of this relay are servers / CLIs reaching each other
/// over the public internet via STUN, so we never produce or receive
/// `.local` candidates. Leaving the setting at webrtc-rs's default
/// (`QueryOnly`) makes every `RTCPeerConnection` open an
/// `Arc<webrtc_mdns::Conn>` bound to `224.0.0.251:5353` for the lifetime
/// of the agent, and `peer_connection.close()` in webrtc-rs 0.12 does not
/// fully drop that Conn — each peer over the lifetime of the process leaks
/// one UDP fd plus an unbounded kernel receive buffer. In production this
/// accumulated to ~200 sockets and ~2.4k pps of mDNS amplification on the
/// LAN after a few days of uptime. Disabling the mode short-circuits the
/// Conn creation entirely (see `create_multicast_dns` in webrtc-ice), so
/// the leak cannot occur.
fn build_api() -> webrtc::api::API {
    use webrtc::api::setting_engine::SettingEngine;
    use webrtc_ice::mdns::MulticastDnsMode;
    use webrtc_ice::network_type::NetworkType;

    let mut se = SettingEngine::default();
    se.set_network_types(vec![NetworkType::Udp4]);
    se.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);
    webrtc::api::APIBuilder::new()
        .with_setting_engine(se)
        .build()
}
